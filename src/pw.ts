import dayjs from 'dayjs';
import dotenv from 'dotenv';
import fs from 'fs/promises';
import fetch from 'node-fetch';
import * as os from 'os';
import path from 'path';
import { chromium, devices } from 'playwright';
import { fileURLToPath } from 'url';

interface Patient {
  visitNo: string;
  name: string;
  Identification?: string[];
  SLIC_Docs?: string[];
  Hospital_DS?: string[];
  Treatment_Sheet?: string[];
  Labs?: string[];
  Radiology?: string[];
  Sticker?: string[];
  8?: string[];
  Birth?: string[];
  Other?: string[];
  11?: string[];
}
const docTypesMap = {
  1: 'Identification',
  2: 'SLIC_Docs',
  3: 'Hospital_DS',
  4: 'Treatment_Sheet',
  5: 'Labs',
  6: 'Radiology',
  7: 'Sticker',
  // 8: '14',
  9: 'Birth',
  10: 'Other',
  // 11: '16',
};

async function getHook() {
  try {
    const hookRes = await fetch('https://usama8800.net/server/kv/dg');
    const text = await hookRes.text();
    if (text.startsWith('http')) discordHook = text;
  } catch (error) { /* empty */ }
}

function log(...args: any[]) {
  console.log(...args);
  appendLogFile(args.map(x => {
    if (typeof x === 'object') return JSON.stringify(x);
    return x;
  }).join(' '));
}

function appendLogFile(str: string) {
  logFileData += `>>>\t${str}\n`;
}

async function repeatUntil(repeat: any, until: any) {
  let done = false;
  await repeat();
  while (!done) {
    try {
      await until();
      done = true;
    } catch (error: any) {
      if (error.name !== 'TimeoutError') throw error;
      await repeat();
    }
  }
}

async function getPatients() {
  const patients: Patient[] = [];
  const patientFolders = await fs.readdir(config.folder);

  patientLoop: for (const patientFolder of patientFolders) {
    const visitNoMatch = patientFolder.match(/(\d+)$/);
    if (!visitNoMatch) {
      log(patientFolder, 'visit number not found at end');
      continue;
    }
    const visitNo = visitNoMatch[1];
    const patient: Patient = { visitNo, name: patientFolder };

    const names = await fs.readdir(path.resolve(config.folder, patientFolder));
    for (const name of names) {
      if (name === `${visitNo}.pdf`) continue;
      const pathname = path.resolve(config.folder, patientFolder, name);
      const nameMatch = name.match(/^(\d+)/);
      let stat = await fs.stat(pathname);
      if (!nameMatch) {
        log(`${patientFolder} has bad folder or file name '${name}'`);
        continue patientLoop;
      }
      const docType = docTypesMap[nameMatch[1]];
      if (!docType) {
        log(`${patientFolder} has bad folder or file name '${name}'`);
        continue patientLoop;
      }

      if (stat.isDirectory()) {
        const filenames = await fs.readdir(pathname);
        for (let i = 0; i < filenames.length; i++) {
          filenames[i] = path.resolve(pathname, filenames[i]);
          stat = await fs.stat(filenames[i]);
          if (stat.isDirectory()) {
            log(`${patientFolder} has a folder inside '${name}'`);
            continue patientLoop;
          }
        }

        patient[docType] = filenames;
      } else {
        patient[docType] = [pathname];
      }
    }
    if (!patient.Identification?.length || !patient.SLIC_Docs?.length) {
      log(`${patientFolder} does not have required parts 1 and 2`);
      continue;
    }
    patients.push(patient);
  }

  return patients;
}

// Setup
dotenv.config({ override: true });
const __dirname = fileURLToPath(new URL('.', import.meta.url));
const downloadPath = path.resolve(__dirname, '..', 'downloads');
let discordHook: string | undefined;
const logFilePath = 'log.txt';
let logFileData = '';
const config = {
  folder: 'patients',
  freshDischarges: true,
  objectedClaims: true,
  forceDischarge: false,
};
if (process.env.MODE === 'dev') {
  config.objectedClaims = false;
  config.forceDischarge = true;
}

async function main() {
  const browser = await chromium.launch({
    headless: process.env.MODE !== 'dev',
  });
  const context = await browser.newContext(devices['Desktop Chrome']);
  const page = await context.newPage();

  await page.goto('https://apps.slichealth.com/ords/ihmis_admin/r/eclaim-upload/home');

  await page.type('#P9999_USERNAME', process.env.username!);
  await page.type('#P9999_PASSWORD', process.env.password!);
  await page.click('button[id]');
  const session = new URL(page.url()).searchParams.get('session');

  // await repeatUntil(
  //   () => page.click('#t_Button_navControl', { delay: 100, position: { x: 10, y: 10 } }),
  //   async () => {
  //     await page.locator('#t_TreeNav').getByText('Eclaim Upload').click({ timeout: 500, noWaitAfter: true });
  //     await page.waitForLoadState('domcontentloaded');
  //   });

  if (config.freshDischarges) {
    // await repeatUntil(
    //   () => page.click('#freshCase_actions_button'),
    //   () => page.getByText('Download').click({ timeout: 100 }));
    // await page.click('label[for="freshCase_plain"] span');
    // await page.click('li[data-value="XLSX"]');
    // const downloadPromise = page.waitForEvent('download');
    // await page.locator('//*[@id="t_PageBody"]/div[12]/div[3]/div/button[2]').click();
    // const download = await downloadPromise;
    // await download.saveAs(path.resolve(downloadPath, download.suggestedFilename()));
    // await page.locator('//*[@id="t_PageBody"]/div[12]/div[1]/button').click();

    const patients = await getPatients();
    for (const patient of patients) {
      await page.goto(`https://apps.slichealth.com/ords/ihmis_admin/r/eclaim-upload/compress-upload?p14_visitno=${patient.visitNo}&session=${session}`);
      console.log(patient);
      if (patient.Identification) await page.locator('#Identification').setInputFiles(patient.Identification);
      if (patient.SLIC_Docs) await page.locator('#SLIC_Docs').setInputFiles(patient.SLIC_Docs);
      if (patient.Hospital_DS) await page.locator('#Hosptial_DS').setInputFiles(patient.Hospital_DS);
      if (patient.Labs) await page.locator('#Labs').setInputFiles(patient.Labs);
      if (patient.Other) await page.locator('#Other').setInputFiles(patient.Other);
      if (patient.Radiology) await page.locator('#Radiology').setInputFiles(patient.Radiology);
      if (patient.Sticker) await page.locator('#Sticker').setInputFiles(patient.Sticker);
      if (patient.Treatment_Sheet) await page.locator('#Treatment_Sheet').setInputFiles(patient.Treatment_Sheet);
      await page.getByText('Preview').click();
      const requestPromise = page.waitForRequest('https://apps.slichealth.com/ords/ihmis_admin/eclaim/eclaim_upload_fresh_docs');
      await page.locator('#uploadBtn').click();
      const request = await requestPromise;
      const response = await request.response();
      if (!response) {
        log(`${patient.visitNo}: Error! No response from uploading`);
        continue;
      }
      const json = await response.json();
      if (json.status !== 'success') {
        log(`${patient.visitNo}: Error! ${json.message}`);
        continue;
      }
    }
  }
  if (config.objectedClaims) {
    await page.goto(`https://apps.slichealth.com/ords/ihmis_admin/r/eclaim-upload/fresh-cases?session=${session}`);
    await page.getByRole('tab', { name: 'OBJECTED CASES' }).click();
    await repeatUntil(
      () => page.click('#R81197857333853230_actions_button'),
      () => page.click('#R81197857333853230_actions_menu_12i', { timeout: 100 }));
    await page.click('label[for="R81197857333853230_plain"] span');
    await page.click('li[data-value="XLSX"]');
    const downloadPromise = page.waitForEvent('download');
    await page.locator('//*[@id="t_PageBody"]/div[12]/div[3]/div/button[2]').click();
    const download = await downloadPromise;
    await download.saveAs(path.resolve(downloadPath, download.suggestedFilename()));
    await page.locator('//*[@id="t_PageBody"]/div[12]/div[1]/button').click();
  }

  // Teardown
  if (process.env.MODE !== 'dev') {
    await context.close();
    await browser.close();
  }

}
const date = dayjs().format();
const header = `**MSK Statelife** @ _${os.userInfo().username}_ | _${os.hostname()}_: \`${date}\`\n`;
const c = '```';
let handlingSigInt = false;
const handler = async (reason: any) => {
  if (handlingSigInt) return;
  if (!reason.isSigInt) console.log(reason);
  if (reason.isSigInt) handlingSigInt = true;
  if (discordHook && process.env.MODE !== 'dev') {
    const content = reason.isSigInt ? `SIGINT\n${c}${logFileData}${c}` : `Uncaught Error\n${c}${reason.stack}${c}`;
    try {
      await fetch(discordHook!, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          content: `${header}\n${content}`,
        }),
      });
    } catch (error) { /* empty */ }
  }
  process.exit(1);
};
process
  .on('unhandledRejection', handler)
  .on('uncaughtException', handler)
  .on('SIGINT', () => handler({ isSigInt: true }));
if (process.argv.length > 2) {
  let patientsPath = process.argv.slice(2).join(' ');
  if (!patientsPath.startsWith('"') && patientsPath.endsWith('"'))
    patientsPath = patientsPath.slice(0, -1);
  patientsPath = patientsPath.replace(/\^([^^])?/g, '$1');
  config.folder = patientsPath;
} else {
  // log('Folder not given. Using ./patients');
}
if (process.env.MODE !== 'dev') getHook();
main().then(() => {
  fs.writeFile(logFilePath, logFileData);
  if (discordHook && process.env.MODE !== 'dev') {
    fetch(discordHook!, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        content: `${header}${logFileData}`,
      }),
    });
  }
});
