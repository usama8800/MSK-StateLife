import { booleanSchema, loadEnv } from '@usama8800/dotenvplus';
import { parallelLimit } from 'async';
import fsE from 'fs-extra';
import _ from 'lodash';
import { parse as parsePath, resolve } from 'path';
import * as PDFLib from 'pdf-lib';
import { BrowserContext, Page, chromium, devices } from 'playwright';
import XLSX from 'xlsx-js-style';
import { z } from 'zod';
import { XLSXCell } from './models';

const env = loadEnv({
  schema: z.strictObject({
    MODE: z.union([z.literal(''), z.literal('dev')]).default(''),
    NODE_TLS_REJECT_UNAUTHORIZED: booleanSchema,
    username: z.string(),
    password: z.string(),
    UPLOAD_FRESH_CASES: booleanSchema.optional(),
    DOWNLOAD_OBJECTED_CASES: booleanSchema.optional(),
    DOWNLOAD_CLARIFICATION_CASES: booleanSchema.optional(),
    DOWNLOAD_SUBMITTED_CASES: booleanSchema.optional(),
    DOWNLOAD_REJECTED_CASES: booleanSchema.optional(),
    // Normally files are expected inside a patient folder.
    // With this true, folders are allowed
    // and all supported files are converted into one pdf
    CONVERT_TO_PDF: booleanSchema.optional(),
    HEADLESS: booleanSchema.optional(),
    FORCE: booleanSchema.optional(),
    PATIENTS_FOLDER: z.string().default('patients'),
    DOWNLOADS_FOLDER: z.string().default('downloads'),
    PERMANENT_2FA: z.string().optional(),
    PARALLEL_UPLOADS: z.coerce.number().default(1),
    PARALLEL_DOWNLOADS: booleanSchema.optional(),
  }),
});
process.env.NODE_TLS_REJECT_UNAUTHORIZED = env.NODE_TLS_REJECT_UNAUTHORIZED ? '1' : '0';

const logFilePath = 'log.txt';
let logFileData = '';

interface Patient {
  visitNo: string;
  name: string;
  docs: {
    Identification: string;
    SLIC_Docs: string;
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
const docTypesMap: Record<string, string> = {
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

async function writeAOAtoXLSXFile(data: XLSXCell[][], filename: string) {
  const book = XLSX.utils.book_new();
  const sheet = XLSX.utils.aoa_to_sheet(data);
  XLSX.utils.book_append_sheet(book, sheet);
  const fileBuffer = XLSX.write(book, {
    bookType: 'xlsx',
    type: 'buffer',
  });
  await fsE.writeFile(resolve(env.DOWNLOADS_FOLDER, `${filename}.xlsx`), fileBuffer);
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
  const nextButtonXPath = 'css=button[aria-label=\'Next\']';
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
        if (env.MODE === 'dev') await page.pause();
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
  return _.uniqBy(cases, (c) => Object.keys(c).sort().map(k => c[k]).join('~'));
}

async function getPatients() {
  log('Reading patients folder...');
  const patients: Patient[] = [];
  const patientFolders = await fsE.readdir(env.PATIENTS_FOLDER);

  patientLoop: for (const patientFolder of patientFolders) {
    const visitNoMatch = patientFolder.match(/(\d+)$/);
    if (!visitNoMatch) {
      log(`'${patientFolder}' visit number not found at end`);
      continue;
    }
    const visitNo = visitNoMatch[1];
    const patient: Patient = { visitNo, name: patientFolder, docs: {} as any };

    const dirs = await fsE.readdir(resolve(env.PATIENTS_FOLDER, patientFolder));
    for (let filename of dirs) {
      let dirpath = resolve(env.PATIENTS_FOLDER, patientFolder, filename);
      const nameMatch = filename.match(/^(\d+)/);
      if (!nameMatch) {
        log(`${patientFolder} has bad file name '${filename}'`);
        continue patientLoop;
      }
      const docType = docTypesMap[nameMatch[1]];
      if (!docType) {
        log(`${patientFolder} has bad file name '${filename}'`);
        continue patientLoop;
      }
      if (patient.docs[docType] && (parsePath(filename).ext !== '.pdf' || !env.CONVERT_TO_PDF)) {
        log(`${patientFolder} has multiple files of type '${docType}'`);
        continue patientLoop;
      }

      let stat = await fsE.stat(dirpath);
      if (stat.isDirectory() && !env.CONVERT_TO_PDF) {
        log(`${patientFolder} has a directory '${filename}'. Should be a pdf file`);
        continue patientLoop;
      } else if (stat.isDirectory()) {
        const mergedPdf = await PDFLib.PDFDocument.create();
        const filenames = await fsE.readdir(dirpath);
        if (filenames.length === 0) continue;
        for (let i = 0; i < filenames.length; i++) {
          const filepath = resolve(dirpath, filenames[i]);
          stat = await fsE.stat(filepath);
          if (stat.isDirectory()) {
            log(`${patientFolder} has a folder inside '${filename}'`);
            continue patientLoop;
          }
          if (filepath.endsWith('.jpg') || filepath.endsWith('.jpeg')) {
            const jpgImage = await mergedPdf.embedJpg(await fsE.readFile(filepath));
            const page = mergedPdf.addPage();
            page.drawImage(jpgImage, {
              x: 0,
              y: 0,
              width: page.getWidth(),
              height: page.getHeight(),
            });
          } else if (filepath.endsWith('.pdf')) {
            const pdf = await fsE.readFile(filepath);
            const document = await PDFLib.PDFDocument.load(pdf);
            const copiedPages = await mergedPdf.copyPages(document, document.getPageIndices());
            copiedPages.forEach((page) => mergedPdf.addPage(page));
            // } else if (filepath.endsWith('.docx') || filepath.endsWith('.doc')) {
            //   const tmpPath = resolve(os.tmpdir(), 'tmp.docx');
            //   await fsE.copyFile(filepath, tmpPath);
            //   await fsE.remove(resolve(os.tmpdir(), 'tmp.pdf'));
            //   const newFile = await convertWordFiles(tmpPath, 'pdf', os.tmpdir());
            //   if (!await fsE.exists(newFile)) {
            //     console.log(filepath, filepath);
            //     log(`${patientFolder} has a bad file '${filenames[i]}' inside '${filename}'`);
            //     continue patientLoop;
            //   }
            //   const pdf = await fsE.readFile(newFile);
            //   const document = await PDFLib.PDFDocument.load(pdf);
            //   const copiedPages = await mergedPdf.copyPages(document, document.getPageIndices());
            //   copiedPages.forEach((page) => mergedPdf.addPage(page));
          } else {
            log(`${patientFolder} has a bad file '${filenames[i]}' inside '${filename}'`);
            continue patientLoop;
          }
        }
        const pdfBytes = await mergedPdf.save();
        filename = nameMatch[1] + '.pdf';
        dirpath = resolve(env.PATIENTS_FOLDER, patientFolder, filename);
        await fsE.writeFile(dirpath, pdfBytes);
      } else if (filename.endsWith('.jpg') || filename.endsWith('.jpeg')) {
        if (!env.CONVERT_TO_PDF) {
          log(`${patientFolder} has a jpg file '${filename}'. Should be a pdf file`);
          continue patientLoop;
        }
        const mergedPdf = await PDFLib.PDFDocument.create();
        const jpgImage = await mergedPdf.embedJpg(await fsE.readFile(dirpath));
        const page = mergedPdf.addPage();
        page.drawImage(jpgImage, {
          x: 0,
          y: 0,
          width: page.getWidth(),
          height: page.getHeight(),
        });
        const pdfBytes = await mergedPdf.save();
        filename = nameMatch[1] + '.pdf';
        dirpath = resolve(env.PATIENTS_FOLDER, patientFolder, filename);
        await fsE.writeFile(dirpath, pdfBytes);
      }
      patient.docs[docType] = dirpath;
    }
    if (!patient.docs.Identification || !patient.docs.SLIC_Docs) {
      log(`${patientFolder} does not have required parts 1 and 2`);
      continue;
    }
    patients.push(patient);
  }

  return patients;
}

async function newPage(context: BrowserContext) {
  const page = await context.newPage();
  await page.addInitScript({ path: resolve('node_modules', 'xlsx-js-style', 'dist', 'xlsx.min.js') });

  await page.route('**/*', route => {
    if (route.request().resourceType() === 'font') return route.abort();
    if (route.request().resourceType() === 'stylesheeeet') return route.abort();

    if (route.request().url().startsWith('https://eclaim2.slichealth.com/ords/wwv_flow.ajax')) {
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

  return page;
}

async function uploadFreshCase(context: BrowserContext, session: string | null, patient: Patient, page?: Page) {
  const _page = page ? page : await context.newPage();
  while (true) {
    try {
      await _page.goto(`https://eclaim2.slichealth.com/ords/r/ihmis_admin/eclaim-upload/search-fresh-case-visitno?session=${session}`);
      break;
    } catch { /* empty */ }
  }
  await _page.fill('#P4_VISITNO', `${patient.visitNo}`);

  const requestPromise = _page.waitForRequest(`https://eclaim2.slichealth.com/ords/wwv_flow.accept?p_context=eclaim-upload/search-fresh-case-visitno/${session}`);
  const requestPromise2 = _page.waitForRequest(`https://eclaim2.slichealth.com/ords/r/ihmis_admin/eclaim-upload/search-fresh-case-visitno?session=${session}`);
  await _page.press('#P4_VISITNO', 'Enter');
  await requestPromise;
  await requestPromise2;
  const notFoundLocator = _page.getByText('No Case Found!!!');
  const foundLocator = _page.locator('xpath=//*[@id="report_table_freshCase"]/tbody/tr/td[10]/a');
  let found = false;
  while (true) {
    try {
      if (await foundLocator.count() > 0) {
        await foundLocator.click();
        found = true;
        break;
      }
      if (await notFoundLocator.count() > 0) {
        log(`${patient.visitNo}: Not in fresh cases`);
        found = false;
        break;
      }
    } catch { /* empty */ }
  }
  if (found) {
    await _page.waitForURL(u => u.pathname === '/ords/r/ihmis_admin/eclaim-upload/compress-upload' && u.searchParams.has('session') && u.searchParams.has('p14_visitno') && u.searchParams.has('cs'));
    for (const docType of Object.keys(patient.docs)) {
      await _page.locator(`#${docType}`).setInputFiles(patient.docs[docType]);
    }
    await _page.getByRole('button', { name: 'Preview' }).first().click();
    if (env.MODE === 'dev') {
      await _page.waitForTimeout(2000);
    } else {
      await _page.locator('#uploadBtn').click();
      await _page.waitForLoadState('networkidle');
    }
  }
  if (!page) await _page.close();
}

async function downloadSubmittedCases(context: BrowserContext, session: string | null, page?: Page) {
  const _page = page ? page : await context.newPage();
  await _page.goto(`https://eclaim2.slichealth.com/ords/r/ihmis_admin/eclaim-upload/submitted-cases-u?session=${session}`);
  const cases = await goThroughPages(_page, 'FRESH CASES');
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
  await writeAOAtoXLSXFile(aoa, 'Submitted Cases');
  if (!page) await _page.close();
}

async function main() {
  const browser = await chromium.launch({
    headless: env.HEADLESS,
    // args: ['--start-maximized'],
    devtools: env.MODE === 'dev',
    timeout: 10 * 60 * 1000,
  });
  const context = await browser.newContext(devices['Desktop Chrome']);
  context.setDefaultTimeout(10 * 60 * 1000);
  const page = await newPage(context);

  try {
    await page.goto('https://eclaim2.slichealth.com/ords/ihmis_admin/r/eclaim-upload/login');
  } catch (error: any) {
    if (error.name === 'TimeoutError') {
      log('TimeoutError. Internet or Website not working');
      process.exit(0);
    }
    throw error;
  }

  await page.type('#P9999_USERNAME', env.username);
  await page.type('#P9999_PASSWORD', env.password);
  // if (env.PERMANENT_2FA) {
  //   await page.type('#P9999_CODE', env.PERMANENT_2FA);
  await page.getByText('Sign In').click();
  // } else {
  //   await page.focus('#P9999_CODE');
  // }
  await page.waitForURL(u => u.pathname === '/ords/r/ihmis_admin/eclaim-upload/home' && u.searchParams.has('session'), {
    timeout: 3 * 60 * 1000
  });
  const session = new URL(page.url()).searchParams.get('session');

  const promises: Promise<any>[] = [];
  if (env.UPLOAD_FRESH_CASES) {
    const patients = await getPatients();
    log(`Uploading ${patients.length} fresh discharges...`);

    promises.push(parallelLimit(patients.map(p => callback => {
      uploadFreshCase(context, session, p, env.PARALLEL_UPLOADS === 1 ? page : undefined).finally(callback);
    }), env.PARALLEL_UPLOADS));
  }
  if (!env.PARALLEL_DOWNLOADS) await Promise.all(promises);
  if (env.DOWNLOAD_SUBMITTED_CASES) {
    promises.push(downloadSubmittedCases(context, session, env.PARALLEL_UPLOADS === 1 ? page : undefined));
  }

  await Promise.all(promises);
  await context.close();
  await browser.close();
}

(async () => {
  if (process.argv.length > 2) {
    let patientsPath = process.argv.slice(2).join(' ');
    if (!patientsPath.startsWith('"') && patientsPath.endsWith('"'))
      patientsPath = patientsPath.slice(0, -1);
    patientsPath = patientsPath.replace(/\^([^^])?/g, '$1');
    env.PATIENTS_FOLDER = patientsPath;
  } else {
    // log('Folder not given. Using ./patients');
  }
  await fsE.ensureDir(env.DOWNLOADS_FOLDER);
  await main();
  fsE.writeFile(logFilePath, logFileData);
})();
