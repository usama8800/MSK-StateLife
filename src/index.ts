import dayjs from 'dayjs';
import dotenv from 'dotenv';
import fs from 'fs/promises';
import fetch from 'node-fetch';
import * as os from 'os';
import path from 'path';
import * as PDFLib from 'pdf-lib';
import { chromium, devices } from 'playwright';
import { fileURLToPath } from 'url';
import * as XLSX from 'xlsx';

dotenv.config({ override: true });
const __dirname = fileURLToPath(new URL('.', import.meta.url));
let discordHook: string | undefined;
const logFilePath = 'log.txt';
let logFileData = '';
const envOrDefault = (key: string, defaultValue: boolean) => process.env[key] ? process.env[key]?.toLowerCase() === 'true' : defaultValue;
const config = {
  folder: 'patients',
  freshDischarges: envOrDefault('FRESH_DISCHARGES', true),
  objectedClaims: envOrDefault('OBJECTED_CLAIMS', true),
  convertToPDF: envOrDefault('CONVERT_TO_PDF', true),
  headless: envOrDefault('HEADLESS', process.env.MODE !== 'dev'),
};

interface Patient {
  visitNo: string;
  name: string;
  docs: {
    Identification?: string;
    SLIC_Docs?: string;
    Hosptial_DS?: string;
    Treatment_Sheet?: string;
    Labs?: string;
    Radiology?: string;
    Sticker?: string;
    Reserve_Fund?: string;
    Birth?: string;
    Other?: string;
    DeathReport?: string;
  }
}
const docTypesMap = {
  1: 'Identification',
  2: 'SLIC_Docs',
  3: 'Radiology', // 6
  4: 'Hosptial_DS', // 3
  5: 'Reserve_Fund',
  6: 'Labs', // 5
  7: 'Treatment_Sheet', // 4
  8: 'Other', // 9
  9: 'Sticker', // 7
  10: 'DeathReport',
  11: 'Birth', // 8
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
      const ret = await until();
      if (ret === false) throw new Error('Repeat');
      done = true;
    } catch (error: any) {
      const id = error.name === 'Error' ? error.message : error.name;
      if (!['TimeoutError', 'Repeat'].includes(id)) throw error;
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
    const patient: Patient = { visitNo, name: patientFolder, docs: {} };

    const names = await fs.readdir(path.resolve(config.folder, patientFolder));
    for (let name of names) {
      let pathname = path.resolve(config.folder, patientFolder, name);
      const nameMatch = name.match(/^(\d+)/);
      if (!nameMatch) {
        log(`${patientFolder} has bad file name '${name}'`);
        continue patientLoop;
      }
      const docType = docTypesMap[nameMatch[1]];
      if (!docType) {
        log(`${patientFolder} has bad file name '${name}'`);
        continue patientLoop;
      }
      if (patient.docs[docType] && (!config.convertToPDF || !name.endsWith('.pdf'))) {
        log(`${patientFolder} has multiple files of type '${docType}'`);
        continue patientLoop;
      }

      let stat = await fs.stat(pathname);
      if (stat.isDirectory() && !config.convertToPDF) {
        log(`${patientFolder} has a directory '${name}'. Should be a pdf file`);
        continue patientLoop;
      } else if (stat.isDirectory()) {
        const mergedPdf = await PDFLib.PDFDocument.create();
        const filenames = await fs.readdir(pathname);
        if (filenames.length === 0) {
          log(`${patientFolder} has an empty folder '${name}'`);
          continue patientLoop;
        }
        for (let i = 0; i < filenames.length; i++) {
          const filepath = path.resolve(pathname, filenames[i]);
          stat = await fs.stat(filepath);
          if (stat.isDirectory()) {
            log(`${patientFolder} has a folder inside '${name}'`);
            continue patientLoop;
          }
          if (filepath.endsWith('.jpg') || filepath.endsWith('.jpeg')) {
            const jpgImage = await mergedPdf.embedJpg(await fs.readFile(filepath));
            const page = mergedPdf.addPage();
            page.drawImage(jpgImage, {
              x: 0,
              y: 0,
              width: page.getWidth(),
              height: page.getHeight(),
            });
          } else if (filepath.endsWith('.pdf')) {
            const pdf = await fs.readFile(filepath);
            const document = await PDFLib.PDFDocument.load(pdf);
            await mergedPdf.copyPages(document, document.getPageIndices());
          } else {
            log(`${patientFolder} has a bad file '${filenames[i]}' inside '${name}'`);
            continue patientLoop;
          }
        }
        const pdfBytes = await mergedPdf.save();
        name = nameMatch[1] + '.pdf';
        pathname = path.resolve(config.folder, patientFolder, name);
        await fs.writeFile(pathname, pdfBytes);
      } else if (name.endsWith('.jpg') || name.endsWith('.jpeg')) {
        if (!config.convertToPDF) {
          log(`${patientFolder} has a jpg file '${name}'. Should be a pdf file`);
          continue patientLoop;
        }
        const mergedPdf = await PDFLib.PDFDocument.create();
        const jpgImage = await mergedPdf.embedJpg(await fs.readFile(pathname));
        const page = mergedPdf.addPage();
        page.drawImage(jpgImage, {
          x: 0,
          y: 0,
          width: page.getWidth(),
          height: page.getHeight(),
        });
        const pdfBytes = await mergedPdf.save();
        name = nameMatch[1] + '.pdf';
        pathname = path.resolve(config.folder, patientFolder, name);
        await fs.writeFile(pathname, pdfBytes);
      }
      patient.docs[docType] = pathname;
    }
    if (!patient.docs.Identification || !patient.docs.SLIC_Docs) {
      log(`${patientFolder} does not have required parts 1 and 2`);
      continue;
    }
    patients.push(patient);
  }

  return patients;
}

async function main() {
  const browser = await chromium.launch({
    headless: config.headless,
  });
  const context = await browser.newContext(devices['Desktop Chrome']);
  const page = await context.newPage();

  try {
    await page.goto('https://apps.slichealth.com/ords/ihmis_admin/r/eclaim-upload/home');
  } catch (error: any) {
    if (error.name === 'TimeoutError') {
      log('TimeoutError. Internet or Website not working');
      return;
    }
    throw error;
  }

  await page.type('#P9999_USERNAME', process.env.username!);
  await page.type('#P9999_PASSWORD', process.env.password!);
  await page.click('button[id]');
  await page.waitForURL(x => x.pathname === '/ords/ihmis_admin/r/eclaim-upload/home' && x.searchParams.has('session'));
  const session = new URL(page.url()).searchParams.get('session');

  if (config.freshDischarges) {
    const patients = await getPatients();
    for (const patient of patients) {
      await page.goto(`https://apps.slichealth.com/ords/ihmis_admin/r/eclaim-upload/compress-upload?p14_visitno=${patient.visitNo}&session=${session}`, { timeout: 60000 });
      for (const docType of Object.keys(patient.docs)) {
        await page.locator(`#${docType}`).setInputFiles(patient.docs[docType]);
      }
      await page.getByText('Preview').click();
      const requestPromise = page.waitForRequest('https://apps.slichealth.com/ords/ihmis_admin/eclaim/eclaim_upload_fresh_docs', { timeout: 60000 });
      await page.locator('#uploadBtn').click({ timeout: 60000 });
      const request = await requestPromise;
      const response = await request.response();
      if (!response) {
        log(`${patient.visitNo}: Error! No response from uploading`);
        continue;
      }
      const json = await response.json();
      if (json.status !== 'success') {
        if (json.message.includes('Claim Already Recieved')) {
          log(`${patient.visitNo}: Error! ${json.message}`);
        } else {
          log(`${patient.visitNo}: Error! ${json.message}`);
        }
        continue;
      } else {
        log(`${patient.visitNo}: Success!`);
      }
    }
  }
  if (config.objectedClaims) {
    await page.goto(`https://apps.slichealth.com/ords/ihmis_admin/r/eclaim-upload/hospital-cases?session=${session}`, { timeout: 60000 });
    await page.addScriptTag({ path: path.resolve(__dirname, '..', 'node_modules', 'xlsx', 'dist', 'xlsx.full.min.js') });
    await repeatUntil(
      () => page.getByRole('tab', { name: 'OBJECTED CASE' }).click(),
      async () => {
        await page.waitForTimeout(100);
        return await page.isVisible('div[data-label="OBJECTED CASE"]');
      });
    const objectedCases: {
      Visitno: number;
      'Patient Name': string;
      'Admission Date': string;
      'Discharge Date': string;
      Los: number;
      'Discharge Type': string;
      Lot: string;
      Treatment: string;
      'Claim Amount': number;
      'Mr Number': number;
    }[] = [];
    const nextButtonXPath = '//div[@data-label="OBJECTED CASE"]//table[2]//a[contains(text(), "Next")]';
    let i = 0;
    await repeatUntil(
      async () => {
        if (i++ === 0) return;
        const loading = page.locator('.u-Processing').waitFor({ state: 'attached' });
        await page.locator(nextButtonXPath).click();
        await loading;
      },
      async () => {
        await page.locator('.u-Processing').waitFor({ state: 'detached' });
        const cases = await page.evaluate(() => {
          const win = window as any;
          const table = win.$('table[aria-label="OBJECTED CASE"]')[0];
          const sheet = win.XLSX.utils.table_to_sheet(table);
          return win.XLSX.utils.sheet_to_json(sheet);
        });
        objectedCases.push(...cases);
        return await page.locator(nextButtonXPath).count() === 0;
      },
    );

    const aoa: string[][] = [
      ['Visit No', 'Description', 'Remarks'],
    ];
    for (const objectedCase of objectedCases) {
      await page.goto(`https://apps.slichealth.com/ords/ihmis_admin/r/eclaim-upload/objected-file-upload?p11_visitno=${objectedCase.Visitno}&session=${session}`, { timeout: 60000 });
      const desc = await page.locator('//table[@aria-label="Missing Docs"]//td[@headers="DESCRIPTION"]').allTextContents();
      const remarks = await page.locator('//table[@aria-label="Missing Docs"]//td[@headers="REMARKS"]').allTextContents();
      if (desc.length !== remarks.length) {
        log(`${objectedCase.Visitno}: Error! Desc and remarks length mismatch`);
        aoa.push([`${objectedCase.Visitno}`, desc.join('\n'), remarks.join('\n')]);
      } else {
        for (let j = 0; j < desc.length; j++) {
          aoa.push([`${objectedCase.Visitno}`, desc[j], remarks[j]]);
        }
      }
    }
    const book = XLSX.utils.book_new();
    const sheet = XLSX.utils.aoa_to_sheet(aoa);
    XLSX.utils.book_append_sheet(book, sheet, 'Objected Claims');
    const fileBuffer = XLSX.write(book, {
      bookType: 'xlsx',
      type: 'buffer',
    });
    await fs.writeFile(path.resolve(__dirname, '..', 'Objected Claims.xlsx'), fileBuffer);
    log('Objected Claims.xlsx saved');
  }

  // Teardown
  if (config.headless) {
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
