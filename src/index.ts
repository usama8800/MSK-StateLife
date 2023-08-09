import { convertWordFiles } from 'convert-multiple-files';
import dayjs from 'dayjs';
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

async function writeAOAtoXLSXFile(data: any[][], filename: string) {
  const book = XLSX.utils.book_new();
  const sheet = XLSX.utils.aoa_to_sheet(data);
  XLSX.utils.book_append_sheet(book, sheet, 'Fresh Claims');
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

async function openTab(page: Page, tab: string) {
  await repeatUntil(
    () => page.getByRole('tab', { name: tab }).click(),
    async () => {
      await page.waitForTimeout(100);
      return await page.isVisible(`div[data-label="${tab}"]`);
    });
}

async function goThroughPages(page: Page, tab: string) {
  const cases: Claim[] = [];
  const nextButtonXPath = `//div[@data-label="${tab}"]//table[2]//a[contains(text(), "Next")]`;
  await repeatUntil(
    async () => { },
    async () => {
      const spinners = await page.locator('.u-Processing').all();
      await Promise.all(spinners.map(x => x.waitFor({ state: 'detached' })));
      const _cases = await page.evaluate((_tab) => {
        const win = window as any;
        const table = win.$(`table[aria-label="${_tab}"]`)[0];
        const sheet = win.XLSX.utils.table_to_sheet(table);
        const json = win.XLSX.utils.sheet_to_json(sheet);
        return json;
      }, tab);
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
        if (filenames.length === 0) continue patientLoop;
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

  await page.route('**/*', route => {
    if (!['document', 'script', 'xhr', 'fetch'].includes(route.request().resourceType())) return route.abort();
    if (route.request().url() === 'https://apps.slichealth.com/ords/wwv_flow.ajax') {
      const data = route.request().postData();
      if (data && data.includes('p_widget_action=paginate')) {
        const minMatch = data.match(/p_pg_min_row=(\d+)/);
        const maxMatch = data.match(/p_pg_max_rows=(\d+)/);
        const fetchedMatch = data.match(/p_pg_rows_fetched=(\d+)/);
        if (minMatch && maxMatch && fetchedMatch) {
          const min = parseInt(minMatch[1]);
          const max = parseInt(maxMatch[1]);
          const fetched = parseInt(fetchedMatch[1]);
          if (min < 2 << 16 - 1) {
            const newMax = 2 << 16 - 1;
            // const newFetched = newMax - min;
            const newData = data
              .replace(`p_pg_max_rows=${max}`, `p_pg_max_rows=${newMax}`)
              .replace(`p_pg_rows_fetched=${fetched}`, `p_pg_rows_fetched=${newMax}`);
            route.continue({
              postData: newData,
            });
            return;
          }
        }
      }
    }
    return route.continue();
  });

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

  let freshCases: Claim[] = [];
  if (config.freshClaims) {
    await page.goto(`https://apps.slichealth.com/ords/ihmis_admin/r/eclaim-upload/hospital-cases?session=${session}`, { timeout: 60000 });
    await page.addScriptTag({ path: path.resolve(__dirname, '..', 'node_modules', 'xlsx', 'dist', 'xlsx.full.min.js') });
    await openTab(page, 'FRESH CASES');
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
  if (config.freshDischarges) {
    const patients = await getPatients();
    log(`Uploading ${patients.length} fresh discharges...`);
    for (const patient of patients) {
      if (!config.force && freshCases.length > 0 && !freshCases.some(x => x.Visitno === +patient.visitNo)) {
        log(`${patient.visitNo}: Not in fresh cases`);
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
        log(`${patient.visitNo}: Error! No response from uploading`);
        continue;
      }
      const json = await response.json();
      if (json.status !== 'success') {
        if (json.message.includes('Claim Already Recieved')) {
          log(`${patient.visitNo}: Already uploaded`);
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
    await openTab(page, 'OBJECTED CASE');
    const cases = await goThroughPages(page, 'OBJECTED CASE');
    const aoa: string[][] = [
      [...Object.keys(cases[0] ?? {}), 'Description', 'Remarks'],
    ];
    for (const _case of cases) {
      await page.goto(`https://apps.slichealth.com/ords/ihmis_admin/r/eclaim-upload/objected-file-upload?p11_visitno=${_case.Visitno}&session=${session}`, { timeout: 60000 });
      const desc = await page.locator('//table[@aria-label="Missing Docs"]//td[@headers="DESCRIPTION"]').allTextContents();
      const remarks = await page.locator('//table[@aria-label="Missing Docs"]//td[@headers="REMARKS"]').allTextContents();
      const as: string[][] = [];
      const a: string[] = [];
      for (let j = 0; j < aoa[0].length - 2; j++) {
        a.push(_case[aoa[0][j]] ?? '');
      }
      if (desc.length !== remarks.length) {
        log(`${_case.Visitno}: Error! Desc and remarks length mismatch`);
        a.push(desc.join('\n'), remarks.join('\n'));
        as.push(a);
      } else {
        for (let j = 0; j < desc.length; j++) {
          as.push([...a, desc[j], remarks[j]]);
        }
      }
      aoa.push(...as);
    }
    await writeAOAtoXLSXFile(aoa, 'Objected Claims');
  }
  if (config.sumbittedClaims) {
    await page.goto(`https://apps.slichealth.com/ords/ihmis_admin/r/eclaim-upload/hospital-cases?session=${session}`, { timeout: 60000 });
    await page.addScriptTag({ path: path.resolve(__dirname, '..', 'node_modules', 'xlsx', 'dist', 'xlsx.full.min.js') });
    await openTab(page, 'SUBMITTED CASE');
    const cases = await goThroughPages(page, 'SUBMITTED CASE');
    const aoa: string[][] = [
      Object.keys(cases[0] ?? {}),
    ];
    for (const _case of cases) {
      const a: string[] = [];
      for (let j = 0; j < aoa[0].length; j++) {
        a.push(_case[aoa[0][j]] ?? '');
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
