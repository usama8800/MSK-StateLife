import { execSync } from 'child_process';
import { convertWordFiles } from 'convert-multiple-files';
import dayjs from 'dayjs';
import customParseFormat from 'dayjs/plugin/customParseFormat.js';
import dotenv from 'dotenv';
import fsE from 'fs-extra';
import fsP from 'fs/promises';
import fetch from 'node-fetch';
import * as os from 'os';
import path from 'path';
import * as PDFLib from 'pdf-lib';
import { Page, chromium, devices } from 'playwright';
import { fileURLToPath } from 'url';
import * as XLSX from 'xlsx';
import { XLSXCell, cellValue } from './models.js';

dayjs.extend(customParseFormat);
dotenv.config({ override: true });
const __dirname = fileURLToPath(new URL('.', import.meta.url));
const downloadsFolder = path.resolve(__dirname, '..', 'downloads');
let discordHook: string | undefined;
const logFilePath = 'log.txt';
let logFileData = '';
const envOrDefault = (key: string, defaultValue: boolean) => process.env[key] ? process.env[key]?.toLowerCase() === 'true' : defaultValue;
const config = {
  folder: 'patients',
  freshDischarges: envOrDefault('FRESH_DISCHARGES', true),
  freshClaims: envOrDefault('FRESH_CLAIMS', true),
  objectedClaims: envOrDefault('OBJECTED_CLAIMS', true),
  sumbittedClaims: envOrDefault('SUBMITTED_CLAIMS', true),
  convertToPDF: envOrDefault('CONVERT_TO_PDF', true),
  headless: envOrDefault('HEADLESS', process.env.MODE !== 'dev'),
  force: envOrDefault('FORCE', false),
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
interface Claim {
  Action: string;
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
}
const docTypesMap = {
  1: 'Identification',
  2: 'SLIC_Docs',
  3: 'Radiology',
  4: 'Hosptial_DS',
  5: 'Reserve_Fund',
  6: 'Labs',
  7: 'Treatment_Sheet',
  8: 'Other',
  9: 'Sticker',
  10: 'DeathReport',
  11: 'Birth',
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

function getGitHash() {
  try {
    const hash = execSync('git rev-parse HEAD').toString().trim();
    return hash;
  } catch (error) {
    return 'Unknown';
  }
}

async function writeAOAtoXLSXFile(data: XLSXCell[][], filename: string) {
  const book = XLSX.utils.book_new();
  const sheet = XLSX.utils.aoa_to_sheet(data);
  XLSX.utils.book_append_sheet(book, sheet);
  const fileBuffer = XLSX.write(book, {
    bookType: 'xlsx',
    type: 'buffer',
  });
  await fsE.writeFile(path.resolve(__dirname, '..', 'downloads', `${filename}.xlsx`), fileBuffer);
  log(`${filename}.xlsx saved`);
}

async function repeatUntil(repeat: any, until: any) {
  await repeat();
  while (true) {
    try {
      const ret = await until();
      if (ret === false) throw new Error('Repeat');
      break;
    } catch (error: any) {
      const id = error.name === 'Error' ? error.message : error.name;
      if (!['TimeoutError', 'Repeat'].includes(id)) throw error;
      await repeat();
    }
  }
}

async function goThroughPages(page: Page, tab: string) {
  const cases: Claim[] = [];
  const nextButtonXPath = 'button[aria-label=\'Next\']';
  await repeatUntil(
    async () => { },
    async () => {
      const spinners = await page.locator('.u-Processing').all();
      await Promise.all(spinners.map(x => x.waitFor({ state: 'detached' })));
      const _cases = await page.evaluate((_tab) => {
        try {
          const win = window as any;
          win.mytable = win.$('table[id$=\'_orig\']')[0];
          console.log(1, win.mytable);
          win.mysheet = win.XLSX.utils.table_to_sheet(win.mytable, {
            raw: true
          });
          console.log(2, win.mysheet);
          win.mykeys = Object.keys(win.mysheet);
          win.mykeys.forEach(k => {
            if (win.mysheet[k].l) {
              win.mysheet[k].t = 's';
              win.mysheet[k].v = win.mysheet[k].l.Target;
            }
          });
          win.myjson = win.XLSX.utils.sheet_to_json(win.mysheet);
          console.log(3, win.myjson);
          return win.myjson;
        } catch (error) {
          return [];
        }
      }, tab);
      if (_cases.length === 0) {
        if (process.env.MODE === 'dev') await page.waitForTimeout(1000000);
        return false;
      }
      cases.push(..._cases);
      const count = await page.locator(nextButtonXPath).count();
      if (count === 0) return true;
      await page.locator(nextButtonXPath).click({ timeout: 3000 });
      await page.waitForTimeout(300);
      return false;
    },
  );
  return cases;
}

async function getPatients() {
  log('Reading patients folder...');
  const patients: Patient[] = [];
  const patientFolders = await fsP.readdir(config.folder);

  patientLoop: for (const patientFolder of patientFolders) {
    const visitNoMatch = patientFolder.match(/(\d+)$/);
    if (!visitNoMatch) {
      log(`'${patientFolder}' visit number not found at end`);
      continue;
    }
    const visitNo = visitNoMatch[1];
    const patient: Patient = { visitNo, name: patientFolder, docs: {} };

    const names = await fsP.readdir(path.resolve(config.folder, patientFolder));
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

      let stat = await fsP.stat(pathname);
      if (stat.isDirectory() && !config.convertToPDF) {
        log(`${patientFolder} has a directory '${name}'. Should be a pdf file`);
        continue patientLoop;
      } else if (stat.isDirectory()) {
        const mergedPdf = await PDFLib.PDFDocument.create();
        const filenames = await fsP.readdir(pathname);
        if (filenames.length === 0) continue;
        for (let i = 0; i < filenames.length; i++) {
          const filepath = path.resolve(pathname, filenames[i]);
          stat = await fsP.stat(filepath);
          if (stat.isDirectory()) {
            log(`${patientFolder} has a folder inside '${name}'`);
            continue patientLoop;
          }
          if (filepath.endsWith('.jpg') || filepath.endsWith('.jpeg')) {
            const jpgImage = await mergedPdf.embedJpg(await fsP.readFile(filepath));
            const page = mergedPdf.addPage();
            page.drawImage(jpgImage, {
              x: 0,
              y: 0,
              width: page.getWidth(),
              height: page.getHeight(),
            });
          } else if (filepath.endsWith('.pdf')) {
            const pdf = await fsP.readFile(filepath);
            const document = await PDFLib.PDFDocument.load(pdf);
            const copiedPages = await mergedPdf.copyPages(document, document.getPageIndices());
            copiedPages.forEach((page) => mergedPdf.addPage(page));
          } else if (filepath.endsWith('.docx') || filepath.endsWith('.doc')) {
            const tmpPath = path.resolve(os.tmpdir(), 'tmp.docx');
            await fsP.copyFile(filepath, tmpPath);
            await fsE.remove(path.resolve(os.tmpdir(), 'tmp.pdf'));
            const newFile = await convertWordFiles(tmpPath, 'pdf', os.tmpdir());
            const exists = await fsE.exists(newFile);
            if (!exists) {
              console.log(filepath, pathname);
              log(`${patientFolder} has a bad file '${filenames[i]}' inside '${name}'`);
              continue patientLoop;
            }
            const pdf = await fsP.readFile(newFile);
            const document = await PDFLib.PDFDocument.load(pdf);
            const copiedPages = await mergedPdf.copyPages(document, document.getPageIndices());
            copiedPages.forEach((page) => mergedPdf.addPage(page));
          } else {
            log(`${patientFolder} has a bad file '${filenames[i]}' inside '${name}'`);
            continue patientLoop;
          }
        }
        const pdfBytes = await mergedPdf.save();
        name = nameMatch[1] + '.pdf';
        pathname = path.resolve(config.folder, patientFolder, name);
        await fsP.writeFile(pathname, pdfBytes);
      } else if (name.endsWith('.jpg') || name.endsWith('.jpeg')) {
        if (!config.convertToPDF) {
          log(`${patientFolder} has a jpg file '${name}'. Should be a pdf file`);
          continue patientLoop;
        }
        const mergedPdf = await PDFLib.PDFDocument.create();
        const jpgImage = await mergedPdf.embedJpg(await fsP.readFile(pathname));
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
        await fsP.writeFile(pathname, pdfBytes);
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
  await page.addInitScript({ path: path.resolve(__dirname, '..', 'node_modules', 'xlsx', 'dist', 'xlsx.full.min.js') });

  await page.route('**/*', route => {
    if (route.request().resourceType() === 'font') return route.abort();

    if (route.request().url() === 'https://apps.slichealth.com/ords/wwv_flow.ajax') {
      const data = decodeURIComponent(route.request().postData() ?? '');
      if (data && data.includes('p_widget_action=PAGE')) {
        const match = data.match(/pgR_min_row=(\d+)max_rows=(\d+)rows_fetched=(\d+)/);
        if (match) {
          const min = parseInt(match[1]);
          if (min < 2 << 16 - 1) {
            const newMax = 2 << 16 - 1;
            const newFetched = newMax - min;
            const newData = data
              .replace(match[0], `pgR_min_row=${min}max_rows=${newMax}rows_fetched=${newFetched}`)
              .replace('p_widget_num_return=50', 'p_widget_num_return=' + newFetched);
            route.continue({ postData: newData });
            return;
          }
        }
      }
    }
    return route.continue();
  });

  try {
    await page.goto('https://apps.slichealth.com/ords/ihmis_admin/r/eclaim-upload/home', { timeout: 60000 });
  } catch (error: any) {
    if (error.name === 'TimeoutError') {
      log('TimeoutError. Internet or Website not working');
      process.exit(0);
    }
    throw error;
  }

  await page.type('#P9999_USERNAME', process.env.username!);
  await page.type('#P9999_PASSWORD', process.env.password!);
  if (process.env.PERMANENT_2FA) {
    await page.type('#P9999_CODE', process.env.PERMANENT_2FA);
    await page.getByText('Sign In').click();
  } else {
    await page.focus('#P9999_CODE');
  }
  await page.waitForURL(x => x.pathname === '/ords/ihmis_admin/r/eclaim-upload/home' && x.searchParams.has('session'), {
    timeout: 3 * 60 * 1000
  });
  const session = new URL(page.url()).searchParams.get('session');

  let freshCases: Claim[] = [];
  if (config.freshClaims && '') {
    await page.goto(`https://apps.slichealth.com/ords/ihmis_admin/r/eclaim-upload/search-fresh-case-visitno?clear=4&session=${session}`, { timeout: 60000 });
    freshCases = await goThroughPages(page, 'FRESH CASES');
    const aoa: string[][] = [
      Object.keys(freshCases[0] ?? {}),
    ];
    for (const _case of freshCases) {
      const a: string[] = [];
      for (let j = 0; j < aoa[0].length; j++) {
        a.push(_case[aoa[0][j]] ?? '');
      }
      aoa.push(a);
    }
    await writeAOAtoXLSXFile(aoa, 'Fresh Claims');
  }
  if (config.freshDischarges && '') {
    const patients = await getPatients();
    log(`Uploading ${patients.length} fresh discharges...`);
    for (let i = 0; i < patients.length; i++) {
      const patient = patients[i];
      if (!config.force && freshCases.length > 0 && !freshCases.some(x => x.Visitno === +patient.visitNo)) {
        log(`${i + 1} ${patient.visitNo}: Not in fresh cases`);
        continue;
      }
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
        log(`${i + 1} ${patient.visitNo}: Error! No response from uploading`);
        continue;
      }
      try {
        const json = await response.json();
        if (json.status !== 'success') {
          if (json.message.includes('Claim Already Recieved')) {
            log(`${i + 1} ${patient.visitNo}: Already uploaded`);
          } else {
            log(`${i + 1} ${patient.visitNo}: Error! ${json.message}`);
          }
          continue;
        } else {
          log(`${i + 1} ${patient.visitNo}: Success!`);
        }
      } catch (error) {
        if (response.status() === 200) log(`${i + 1} ${patient.visitNo}: Unkown Status`);
        else {
          log(`${i + 1} ${patient.visitNo}: Error!`);
          log(error);
        }
      }
    }
  }
  if (config.objectedClaims) {
    await page.goto(`https://apps.slichealth.com/ords/ihmis_admin/r/eclaim-upload/objected-cases-u?clear=RP&session=${session}`, { timeout: 60000 });
    const cases = await goThroughPages(page, 'OBJECTED CASE');
    const aoa: XLSXCell[][] = [
      [...Object.keys(cases[0] ?? {}).filter(x => x !== 'Action'), 'Description', 'Files'],
    ];

    for (const _case of cases) {
      await page.goto(`https://apps.slichealth.com${_case.Action}`, { timeout: 60000 });
      const descLocators = await page.locator('//div[@id="R65307116285040317_Cards"]/div/div[3]/ul/li/div/div[1]/div[2]/h3');
      const filesLocators = await page.locator('//div[@id="R65307116285040317_Cards"]/div/div[3]/ul/li/div/div[2]/div');
      const desc = await descLocators.allTextContents();
      const files = await filesLocators.allTextContents();
      const as: XLSXCell[][] = [];
      const a: XLSXCell[] = [];
      for (let j = 0; j < aoa[0].length - 2; j++) {
        if (aoa[0][j] === 'Action') continue;
        if (aoa[0][j] === 'Admission Date') {
          const date = dayjs(_case[cellValue(aoa[0][j])], 'DD-MM-YYYY');
          if (date.isValid()) a.push({ t: 'd', v: date.format('YYYY-MM-DD') });
          else a.push(_case[cellValue(aoa[0][j])]);
        } else if (aoa[0][j] === 'Discharge Date') {
          const date = dayjs(_case[cellValue(aoa[0][j])]);
          if (date.isValid()) a.push({ t: 'd', v: date.format('YYYY-MM-DD') });
          else a.push(_case[cellValue(aoa[0][j])]);
        } else a.push(_case[cellValue(aoa[0][j])] ?? '');
      }
      if (desc.length === files.length) {
        for (let j = 0; j < desc.length; j++) {
          as.push([...a, desc[j], files[j]]);
        }
      } else {
        log(`${_case.Visitno}: Error! Desc and files length mismatch`);
        a.push(desc.join('\n'), files.join('\n'));
        as.push(a);
      }
      aoa.push(...as);
    }
    await writeAOAtoXLSXFile(aoa, 'Objected Claims');
  }
  if (config.sumbittedClaims) {
    await page.goto(`https://apps.slichealth.com/ords/ihmis_admin/r/eclaim-upload/submitted-cases-u?session=${session}`, { timeout: 60000 });
    const cases = await goThroughPages(page, 'SUBMITTED CASE');
    const aoa: XLSXCell[][] = [
      Object.keys(cases[0] ?? {}),
    ];
    for (const _case of cases) {
      const a: XLSXCell[] = [];
      for (let j = 0; j < aoa[0].length; j++) {
        if (aoa[0][j] === 'Admission Date' || aoa[0][j] === 'Discharge Date') {
          const date = dayjs(_case[cellValue(aoa[0][j])], 'DD-MM-YYYY');
          if (date.isValid()) a.push({ t: 'd', v: date.format('YYYY-MM-DD') });
          else a.push(_case[cellValue(aoa[0][j])]);
        } else if (aoa[0][j] === 'Submitted Date') {
          const date = dayjs(_case[cellValue(aoa[0][j])]);
          if (date.isValid()) a.push({ t: 'd', v: date.format('YYYY-MM-DD') });
          else a.push(_case[cellValue(aoa[0][j])]);
        } else a.push(_case[cellValue(aoa[0][j])] ?? '');
      }
      aoa.push(a);
    }
    await writeAOAtoXLSXFile(aoa, 'Submitted Claims');
  }

  // Teardown
  // if (config.headless) {
  await context.close();
  await browser.close();
  // }
}

const date = dayjs().format();
const hash = getGitHash();
const header = `**MSK Statelife** @ _${os.userInfo().username}_ | _${os.hostname()}_: \`${date}\`\n`
  + `${process.argv.join(' ')}\n`
  + `Version: ${hash}\n`;
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
await fsE.ensureDir(downloadsFolder);
await main();
fsP.writeFile(logFilePath, logFileData);
if (discordHook && process.env.MODE !== 'dev') {
  fetch(discordHook!, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      content: `${header}${logFileData}`,
    }),
  });
}
