import { env as dotenv } from '@usama8800/dotenvplus';
// import { convertWordFiles } from 'convert-multiple-files';
import * as fsEE from 'fs-extra';
// import * as fsP from 'fs/promises';
import { parse as parsePath, resolve } from 'path';
import * as PDFLib from 'pdf-lib';
import { chromium, devices } from 'playwright';
import { z } from 'zod';

const fsE = (fsEE as any).default as typeof fsEE;

function booleanParser(value: string) {
  return z.preprocess((val) => {
    if (!val) return false;
    if (typeof val === 'string') {
      if (['1', 'true'].includes(val.toLowerCase())) return true;
      if (['0', 'false'].includes(val.toLowerCase())) return false;
    }
    return val;
  }, z.coerce.boolean()).parse(value);
}

const env = dotenv<{
  MODE: '' | 'dev';
  NODE_TLS_REJECT_UNAUTHORIZED: '0' | '1';
  username: string;
  password: string;
  UPLOAD_FRESH_CASES: boolean;
  DOWNLOAD_FRESH_CLAIMS: boolean;
  DOWNLOAD_OBJECTED_CLAIMS: boolean;
  DOWNLOAD_SUBMITTED_CLAIMS: boolean;
  CONVERT_TO_PDF: boolean;
  HEADLESS: boolean;
  FORCE: boolean;
  PATIENTS_FOLDER: string;
  DOWNLOADS_FOLDER: string;
  PERMANENT_2FA?: string;
}>({
  defaults: {
    MODE: '',
    NODE_TLS_REJECT_UNAUTHORIZED: '0',
    PATIENTS_FOLDER: 'patients',
    DOWNLOADS_FOLDER: 'downloads',
    UPLOAD_FRESH_CASES: true,
    DOWNLOAD_FRESH_CLAIMS: false,
    DOWNLOAD_OBJECTED_CLAIMS: false,
    DOWNLOAD_SUBMITTED_CLAIMS: false,
    CONVERT_TO_PDF: true,
    HEADLESS: false,
    FORCE: false,
  },
  required: ['username', 'password'],
  maps: {
    MODE: v => z.union([z.literal(''), z.literal('dev')]).parse(v),
    NODE_TLS_REJECT_UNAUTHORIZED: v => z.union([z.literal('0'), z.literal('1')]).parse(v),
    UPLOAD_FRESH_CASES: booleanParser,
    DOWNLOAD_FRESH_CLAIMS: booleanParser,
    DOWNLOAD_OBJECTED_CLAIMS: booleanParser,
    DOWNLOAD_SUBMITTED_CLAIMS: booleanParser,
    CONVERT_TO_PDF: booleanParser,
    HEADLESS: booleanParser,
    FORCE: booleanParser,
  },
});

let discordHook: string | undefined;
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
// interface Claim {
//   Action: string;
//   Visitno: number;
//   'Patient Name': string;
//   'Admission Date': string;
//   'Discharge Date': string;
//   Los: number;
//   'Discharge Type': string;
//   Lot: string;
//   Treatment: string;
//   'Claim Amount': number;
//   'Mr Number': number;
// }
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

async function getHook() {
  // try {
  //   const hookRes = await fetch('https://usama8800.net/server/kv/dg');
  //   const text = await hookRes.text();
  //   if (text.startsWith('http')) discordHook = text;
  // } catch (error) { /* empty */ }
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

// function getGitHash() {
//   try {
//     const hash = execSync('git rev-parse HEAD').toString().trim();
//     return hash;
//   } catch (error) {
//     return 'Unknown';
//   }
// }

// async function writeAOAtoXLSXFile(data: XLSXCell[][], filename: string) {
//   const book = XLSX.utils.book_new();
//   const sheet = XLSX.utils.aoa_to_sheet(data);
//   XLSX.utils.book_append_sheet(book, sheet);
//   const fileBuffer = XLSX.write(book, {
//     bookType: 'xlsx',
//     type: 'buffer',
//   });
//   await fsE.writeFile(resolve(__dirname, '..', 'downloads', `${filename}.xlsx`), fileBuffer);
//   log(`${filename}.xlsx saved`);
// }

// async function repeatUntil(repeat: any, until: any) {
//   await repeat();
//   while (true) {
//     try {
//       const ret = await until();
//       if (ret === false) throw new Error('Repeat');
//       break;
//     } catch (error: any) {
//       const id = error.name === 'Error' ? error.message : error.name;
//       if (!['TimeoutError', 'Repeat'].includes(id)) throw error;
//       await repeat();
//     }
//   }
// }

// async function goThroughPages(page: Page, tab: string) {
//   const cases: Claim[] = [];
//   const nextButtonXPath = 'button[aria-label=\'Next\']';
//   await repeatUntil(
//     async () => { },
//     async () => {
//       const spinners = await page.locator('.u-Processing').all();
//       await Promise.all(spinners.map(x => x.waitFor({ state: 'detached' })));
//       const _cases = await page.evaluate((_tab) => {
//         try {
//           const win = window as any;
//           win.mytable = win.$('table[id$=\'_orig\']')[0];
//           console.log(1, win.mytable);
//           win.mysheet = win.XLSX.utils.table_to_sheet(win.mytable, {
//             raw: true
//           });
//           console.log(2, win.mysheet);
//           win.mykeys = Object.keys(win.mysheet);
//           win.mykeys.forEach(k => {
//             if (win.mysheet[k].l) {
//               win.mysheet[k].t = 's';
//               win.mysheet[k].v = win.mysheet[k].l.Target;
//             }
//           });
//           win.myjson = win.XLSX.utils.sheet_to_json(win.mysheet);
//           console.log(3, win.myjson);
//           return win.myjson;
//         } catch (error) {
//           return [];
//         }
//       }, tab);
//       if (_cases.length === 0) {
//         if (env.MODE === 'dev') await page.waitForTimeout(1000000);
//         return false;
//       }
//       cases.push(..._cases);
//       const count = await page.locator(nextButtonXPath).count();
//       if (count === 0) return true;
//       await page.locator(nextButtonXPath).click({ timeout: 3000 });
//       await page.waitForTimeout(300);
//       return false;
//     },
//   );
//   return cases;
// }

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

// Fresh Case button
// https://api2.slichealth.com/ords/nhmis/r/eclaim-upload/search-fresh-case-visitno?clear=4&session=15482292474074

async function main() {
  const browser = await chromium.launch({
    headless: env.HEADLESS,
    // args: ['--start-maximized'],
    devtools: env.MODE === 'dev',
    timeout: 10 * 60 * 1000,
  });
  const context = await browser.newContext(devices['Desktop Chrome']);
  context.setDefaultTimeout(10 * 60 * 1000);
  const page = await context.newPage();
  await page.addInitScript({ path: resolve('node_modules', 'xlsx', 'dist', 'xlsx.full.min.js') });

  await page.route('**/*', route => {
    if (route.request().resourceType() === 'font') return route.abort();

    // if (route.request().url() === 'https://api2.slichealth.com/ords/wwv_flow.ajax') {
    //   const data = decodeURIComponent(route.request().postData() ?? '');
    //   if (data && data.includes('p_widget_action=PAGE')) {
    //     const match = data.match(/pgR_min_row=(\d+)max_rows=(\d+)rows_fetched=(\d+)/);
    //     if (match) {
    //       const min = parseInt(match[1]);
    //       if (min < 2 << 16 - 1) {
    //         const newMax = 2 << 16 - 1;
    //         const newFetched = newMax - min;
    //         const newData = data
    //           .replace(match[0], `pgR_min_row=${min}max_rows=${newMax}rows_fetched=${newFetched}`)
    //           .replace('p_widget_num_return=50', 'p_widget_num_return=' + newFetched);
    //         route.continue({ postData: newData });
    //         return;
    //       }
    //     }
    //   }
    // }
    return route.continue();
  });

  try {
    await page.goto('https://api2.slichealth.com/ords/nhmis/r/eclaim-upload/home');
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
  await page.waitForURL(u => u.pathname === '/ords/nhmis/r/eclaim-upload/home' && u.searchParams.has('session'), {
    timeout: 3 * 60 * 1000
  });
  const session = new URL(page.url()).searchParams.get('session');

  // let freshCases: Claim[] = [];
  if (env.UPLOAD_FRESH_CASES) {
    const patients = await getPatients();
    log(`Uploading ${patients.length} fresh discharges...`);
    patientLoop: for (let i = 0; i < patients.length; i++) {
      const patient = patients[i];
      // if (!env.FORCE && freshCases.length > 0 && !freshCases.some(x => x.Visitno === +patient.visitNo)) {
      //   log(`${i + 1} ${patient.visitNo}: Not in fresh cases`);
      //   continue;
      // }
      while (true) {
        try {
          await page.goto(`https://api2.slichealth.com/ords/nhmis/r/eclaim-upload/search-fresh-case-visitno?session=${session}`);
          break;
        } catch { /* empty */ }
      }
      await page.fill('#P4_VISITNO', `${patient.visitNo}`);
      let requestPromise = page.waitForRequest('https://api2.slichealth.com/ords/wwv_flow.accept');
      const requestPromise2 = page.waitForRequest(`https://api2.slichealth.com/ords/nhmis/r/eclaim-upload/search-fresh-case-visitno?session=${session}`);
      await page.press('#P4_VISITNO', 'Enter');
      await requestPromise;
      await requestPromise2;
      const notFoundLocator = page.getByText('No Case Found!!!');
      const foundLocator = page.locator('xpath=//*[@id="report_table_freshCase"]/tbody/tr/td[10]/a');
      while (true) {
        try {
          if (await foundLocator.count() > 0) {
            await foundLocator.click();
            break;
          }
          if (await notFoundLocator.count() > 0) {
            log(`${i + 1} ${patient.visitNo}: Not in fresh cases`);
            continue patientLoop;
          }
        } catch { /* empty */ }
      }
      await page.waitForURL(u => u.pathname === '/ords/nhmis/r/eclaim-upload/compress-upload' && u.searchParams.has('session') && u.searchParams.has('p14_visitno') && u.searchParams.has('cs'));
      for (const docType of Object.keys(patient.docs)) {
        await page.locator(`#${docType}`).setInputFiles(patient.docs[docType]);
      }
      await page.getByRole('button', { name: 'Preview' }).first().click();
      requestPromise = page.waitForRequest('https://eclaim2.slichealth.com/ords/ihmis_admin/eclaim/eclaim_upload_fresh_docs');
      await page.locator('#uploadBtn').click();
      const request = await requestPromise;
      const response = await request.response();
      if (!response) {
        log(`${i + 1} ${patient.visitNo}: Error! No response from uploading`);
        continue;
      }
      if (response.status() === 200) log(`${i + 1} ${patient.visitNo}: Success!`);
      else log(`${i + 1} ${patient.visitNo}: Error!`);
    }
  }
  if (env.DOWNLOAD_FRESH_CLAIMS) {
    log('Downloading fresh claims not supported');
    // await page.goto(`https://api2.slichealth.com/ords/nhmis/r/eclaim-upload/search-fresh-case-visitno?clear=4&session=${session}`);
    // freshCases = await goThroughPages(page, 'FRESH CASES');
    // const aoa: string[][] = [
    //   Object.keys(freshCases[0] ?? {}),
    // ];
    // for (const _case of freshCases) {
    //   const a: string[] = [];
    //   for (let j = 0; j < aoa[0].length; j++) {
    //     a.push(_case[aoa[0][j]] ?? '');
    //   }
    //   aoa.push(a);
    // }
    // await writeAOAtoXLSXFile(aoa, 'Fresh Claims');
  }
  if (env.DOWNLOAD_OBJECTED_CLAIMS) {
    log('Downloading objected claims not supported');
    // await page.goto(`https://api2.slichealth.com/ords/ihmis_admin/r/eclaim-upload/objected-cases-u?clear=RP&session=${session}`);
    // const cases = await goThroughPages(page, 'OBJECTED CASE');
    // const aoa: XLSXCell[][] = [
    //   [...Object.keys(cases[0] ?? {}).filter(x => x !== 'Action'), 'Description', 'Files'],
    // ];

    // for (const _case of cases) {
    //   await page.goto(`https://apps.slichealth.com${_case.Action}`);
    //   const descLocators = await page.locator('//div[@id="R65307116285040317_Cards"]/div/div[3]/ul/li/div/div[1]/div[2]/h3');
    //   const filesLocators = await page.locator('//div[@id="R65307116285040317_Cards"]/div/div[3]/ul/li/div/div[2]/div');
    //   const desc = await descLocators.allTextContents();
    //   const files = await filesLocators.allTextContents();
    //   const as: XLSXCell[][] = [];
    //   const a: XLSXCell[] = [];
    //   for (let j = 0; j < aoa[0].length - 2; j++) {
    //     if (aoa[0][j] === 'Action') continue;
    //     if (aoa[0][j] === 'Admission Date') {
    //       // const date = dayjs(_case[cellValue(aoa[0][j])], 'DD-MM-YYYY');
    //       // if (date.isValid()) a.push({ t: 'd', v: date.format('YYYY-MM-DD') });
    //       // else a.push(_case[cellValue(aoa[0][j])]);
    //     } else if (aoa[0][j] === 'Discharge Date') {
    //       // const date = dayjs(_case[cellValue(aoa[0][j])]);
    //       // if (date.isValid()) a.push({ t: 'd', v: date.format('YYYY-MM-DD') });
    //       // else a.push(_case[cellValue(aoa[0][j])]);
    //     } else a.push(_case[cellValue(aoa[0][j])] ?? '');
    //   }
    //   if (desc.length === files.length) {
    //     for (let j = 0; j < desc.length; j++) {
    //       as.push([...a, desc[j], files[j]]);
    //     }
    //   } else {
    //     log(`${_case.Visitno}: Error! Desc and files length mismatch`);
    //     a.push(desc.join('\n'), files.join('\n'));
    //     as.push(a);
    //   }
    //   aoa.push(...as);
    // }
    // await writeAOAtoXLSXFile(aoa, 'Objected Claims');
  }
  if (env.DOWNLOAD_SUBMITTED_CLAIMS) {
    log('Downloading submitted claims not supported');
    // await page.goto(`https://api2.slichealth.com/ords/ihmis_admin/r/eclaim-upload/submitted-cases-u?session=${session}`);
    // const cases = await goThroughPages(page, 'SUBMITTED CASE');
    // const aoa: XLSXCell[][] = [
    //   Object.keys(cases[0] ?? {}),
    // ];
    // for (const _case of cases) {
    //   const a: XLSXCell[] = [];
    //   for (let j = 0; j < aoa[0].length; j++) {
    //     if (aoa[0][j] === 'Admission Date' || aoa[0][j] === 'Discharge Date') {
    //       // const date = dayjs(_case[cellValue(aoa[0][j])], 'DD-MM-YYYY');
    //       // if (date.isValid()) a.push({ t: 'd', v: date.format('YYYY-MM-DD') });
    //       // else a.push(_case[cellValue(aoa[0][j])]);
    //     } else if (aoa[0][j] === 'Submitted Date') {
    //       // const date = dayjs(_case[cellValue(aoa[0][j])]);
    //       // if (date.isValid()) a.push({ t: 'd', v: date.format('YYYY-MM-DD') });
    //       // else a.push(_case[cellValue(aoa[0][j])]);
    //     } else a.push(_case[cellValue(aoa[0][j])] ?? '');
    //   }
    //   aoa.push(a);
    // }
    // await writeAOAtoXLSXFile(aoa, 'Submitted Claims');
  }

  // Teardown
  // if (config.headless) {
  await context.close();
  await browser.close();
  // }
}

(async () => {
  // const date = new Date().toISOString();
  // const hash = getGitHash();
  // const header = `**MSK Statelife** @ _${os.userInfo().username}_ | _${os.hostname()}_: \`${date}\`\n`
  //   + `${process.argv.join(' ')}\n`
  //   + `Version: ${hash}\n`;
  // const c = '```';
  let handlingSigInt = false;
  const handler = async (reason: any) => {
    if (handlingSigInt) return;
    if (!reason.isSigInt) console.log(reason);
    if (reason.isSigInt) handlingSigInt = true;
    if (discordHook && env.MODE !== 'dev') {
      // const content = reason.isSigInt ? `SIGINT\n${c}${logFileData}${c}` : `Uncaught Error\n${c}${reason.stack}${c}`;
      try {
        // await fetch(discordHook!, {
        //   method: 'POST',
        //   headers: { 'Content-Type': 'application/json' },
        //   body: JSON.stringify({
        //     content: `${header}\n${content}`,
        //   }),
        // });
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
    env.PATIENTS_FOLDER = patientsPath;
  } else {
    // log('Folder not given. Using ./patients');
  }
  if (env.MODE !== 'dev') getHook();
  await fsE.ensureDir(env.DOWNLOADS_FOLDER);
  await main();
  fsE.writeFile(logFilePath, logFileData);
  if (discordHook && env.MODE !== 'dev') {
    // fetch(discordHook!, {
    //   method: 'POST',
    //   headers: { 'Content-Type': 'application/json' },
    //   body: JSON.stringify({
    //     content: `${header}${logFileData}`,
    //   }),
    // });
  }
})();
