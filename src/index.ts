import axios, { AxiosError, AxiosResponse } from 'axios';
import * as cheerio from 'cheerio';
import dayjs from 'dayjs';
import dotenv from 'dotenv';
import FormData from 'form-data';
import fsLame from 'fs';
import fs, { writeFile } from 'fs/promises';
import https from 'https';
import imagemin from 'imagemin';
import imageminJpegtran from 'imagemin-jpegtran';
import imageminPngquant from 'imagemin-pngquant';
import * as os from 'os';
import { extname, resolve } from 'path';
import { exit } from 'process';
import * as XLSX from 'xlsx';
import { generatePDF, getCookieValue, setCookies } from './utils';

dotenv.config({ override: true });

interface Discharge {
  visitNo: string;
  assignedDate?: string;
  patientName: string;
  hospitalName?: string;
  admissionDate: string;
  dischargeDate: string;
  lengthOfStay: string;
  dischargeType: string;
  lineOfTreatment: string;
  treatment: string;
  claimAmount: string;
  mrNumber: string;
  cnicNo?: string;
  dateOfBirth?: string;
  gender?: string;
  relation?: string;
  maritalStatus?: string;
  eid?: string;
  status?: string;
  submittedDate?: string;
}

interface Patient {
  visitNo: string;
  name: string;
  1?: string[];
  2?: string[];
  7?: string[];
  11?: string[];
  9?: string[];
  6?: string[];
  13?: string[];
  14?: string[];
  15?: string[];
  12?: string[];
  16?: string[];
}

const docTypesMap = {
  1: '1',
  2: '2',
  3: '7',
  4: '11',
  5: '9',
  6: '6',
  7: '13',
  8: '14',
  9: '15',
  10: '12',
  11: '16',
};

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
let freshDischarges: Discharge[] = [];
let objectedClaims: Discharge[] = [];
let cookies: any = {};
let discordHook: string | undefined;
const logFilePath = 'log.txt';
let logFileData = '';


async function main() {
  let res: AxiosResponse<any, any>;
  let reqVerToken = '';
  try {
    res = await axios.get('https://eclaim.slichealth.com/Account/Login');
    cookies = setCookies(res.headers);
    const $ = cheerio.load(res.data);
    reqVerToken = $('input[name=__RequestVerificationToken]').val() as string;
  } catch (error: any) {
    log('Error: Getting login page');
    if (axiosErrorHandler(error)) return;
    else {
      log(error);
      return;
    }
  }

  try {
    res = await axios.post('https://eclaim.slichealth.com/Account/Login', {
      UserName: process.env.username,
      Password: process.env.password,
      __RequestVerificationToken: reqVerToken,
    }, {
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        cookie: getCookieValue(Object.keys(cookies).find(x => x.includes('Antiforgery'))!),
      }
    });
    if (!res.data.success) {
      log('Login failed');
      log('username', process.env.username);
      log('password', process.env.password);
      return;
    }
    setCookies(res.headers);
  } catch (error: any) {
    log('Error: Logging in');
    if (axiosErrorHandler(error)) return;
    else {
      log(error);
      return;
    }
  }

  if (config.freshDischarges) {
    let patients: Patient[] = [];
    try {
      patients = await getPatients();
    } catch (error: any) {
      log('Error: Getting list of patients from folder');
      log(error);
      return;
    }
    if (patients.length) {
      try {
        res = await axios.post('https://eclaim.slichealth.com/Upload/GetFreshDischarges', {}, {
          headers: {
            cookie: getCookieValue(
              Object.keys(cookies).find(x => x.includes('Antiforgery'))!,
              '.AspNetCore.Cookies',
            ),
          }
        });
        if (!res.data.success) {
          log('Getting fresh discharges failed');
          log(res.data);
          return;
        }
        setCookies(res.headers);
        freshDischarges = res.data.responseData.items;
      } catch (error: any) {
        log('Error: Getting fresh discharges list');
        if (axiosErrorHandler(error)) return;
        else {
          log(error);
          return;
        }
      }

      for (const patient of patients) {
        await doFreshDischarge(patient);
      }

      log('Finished fresh discharges');
    }
  }

  if (config.objectedClaims) {
    try {
      res = await axios.post('https://eclaim.slichealth.com/Upload/GetObjectedClaims', {}, {
        headers: {
          cookie: getCookieValue(
            Object.keys(cookies).find(x => x.includes('Antiforgery'))!,
            '.AspNetCore.Cookies',
          ),
        }
      });
      objectedClaims = res.data.responseData.items;
      log('Getting objected claims');
      const aoa: any[][] = [['Visit No', 'Remarks']];
      for (const objectedClaim of objectedClaims) {
        const remark = await getObjectedClaim(objectedClaim.visitNo);
        aoa.push([objectedClaim.visitNo, remark]);
      }
      const book = XLSX.utils.book_new();
      const sheet = XLSX.utils.aoa_to_sheet(aoa);
      XLSX.utils.book_append_sheet(book, sheet, 'Objected Claims');
      XLSX.writeFile(book, 'Objected Claims.xlsx');
      log('Objected claims list saved');

      if (!res.data.success) {
        log('Getting objected claims failed');
        log(res.data);
        exit(1);
      }
    } catch (error: any) {
      log('Error: Getting objected claims list');
      if (axiosErrorHandler(error)) exit(1);
      else {
        log(error);
        exit(1);
      }
    }
  }
}

async function getObjectedClaim(visitNo: string, retry = 0) {
  let res: AxiosResponse<any, any>;
  try {
    res = await axios.get(`https://eclaim.slichealth.com/Upload/EditObjectedClaim?visitNo=${visitNo}`, {
      headers: {
        cookie: getCookieValue(
          Object.keys(cookies).find(x => x.includes('Antiforgery'))!,
          '.AspNetCore.Cookies',
        ),
      }
    });
    const $ = cheerio.load(res.data);
    const remarks = $('textarea').val() as string;
    log(`${visitNo}: ${remarks}`);
    return remarks;
  } catch (error: any) {
    if (retry < 3) {
      return await getObjectedClaim(visitNo, retry + 1);
    }
    log(`Error ${visitNo}: Getting objected claim`);
    appendLogFile('```' + JSON.stringify(error, null, 2) + '```');
    return 'Error getting remarks';
  }
}

async function doFreshDischarge(patient: Patient) {
  const discharge = freshDischarges.find(d => d.visitNo === patient.visitNo);
  if (!discharge && !config.forceDischarge) {
    log(patient.name, 'not in fresh discharge');
    return;
  }

  let token = '';
  try {
    const res = await axios.get('https://eclaim.slichealth.com/Upload/EditFreshDischarge?visitNo=' + patient.visitNo, {
      headers: {
        cookie: getCookieValue(
          Object.keys(cookies).find(x => x.includes('Antiforgery'))!,
          '.AspNetCore.Cookies',
        ),
      }
    });
    token = res.data as string;
    let index = token.indexOf('apiAccessToken');
    token = token.slice(index + 'apiAccessToken = \''.length);
    index = token.indexOf('\'');
    token = token.slice(0, index);
  } catch (error: any) {
    log(`Error ${patient.visitNo}: Getting patient page`);
    if (axiosErrorHandler(error)) return;
    else {
      log(error);
      return;
    }
  }

  const files: any[] = [];
  for (const docType of Object.values(docTypesMap)) {
    for (const file of patient[docType] ?? []) {
      let compressed: Buffer;
      try {
        const f = await fs.readFile(file);
        try {
          compressed = await imagemin.buffer(Buffer.from(f.buffer), {
            plugins: [
              imageminJpegtran(),
              imageminPngquant({
                quality: [0.6, 0.8]
              })
            ]
          });
        } catch (error: any) {
          log(`Error ${patient.visitNo}: Compressing file ${file}`);
          log(error.message);
          return;
        }
      } catch (error: any) {
        log(`Error ${patient.visitNo}: Reading file ${file}`);
        log(error.message);
        return;
      }

      files.push({
        fileData: compressed!.toString('base64'),
        docType,
        fileType: extname(file),
      });
    }
  }
  files.sort((a, b) => a.docType - b.docType || b.docType - a.docType);

  let doc: {
    pdf: Uint8Array;
    pdfDetails: any[];
    allPagesCount: number;
  } = {} as any;
  try {
    doc = await generatePDF(files);
  } catch (error: any) {
    log(`Error ${patient.visitNo}: Generating pdf`);
    log(error.message);
  }
  if (!doc.pdfDetails || doc.pdfDetails.length <= 0) {
    log(`${patient.name}: Error occurred while generating documents`);
    return;
  }
  const mb = parseFloat((doc.pdf.length / (1024 * 1024)).toFixed(2));
  if (mb > 15) {
    // TODO: Check file size > 15 MB
    log(`${patient.name}: Warning! file size > 15 MB`);
  }

  const path = resolve(config.folder, patient.name, patient.visitNo + '.pdf');
  try {
    await fs.writeFile(path, doc.pdf);
  } catch (error: any) {
    log(`Error ${patient.visitNo}: Saving pdf`);
    log(error.message);
    return;
  }
  const formData = new FormData();
  formData.append('file', fsLame.createReadStream(path), { contentType: 'application/pdf' });

  const docDetailsArray: any[] = [];
  for (let i = 0; i < doc.pdfDetails.length; i++) {
    const detailItem = {} as any;
    detailItem.document_type_id = doc.pdfDetails[i].docType;
    detailItem.page_from = doc.pdfDetails[i].startPage;
    detailItem.page_number = doc.pdfDetails[i].totalPages;
    docDetailsArray.push(detailItem);
  }

  const httpsAgent = new https.Agent({
    rejectUnauthorized: false,
  });

  try {
    const res = await axios.post('https://apps.slichealth.com/ords/ihmis_admin/eClaims/upload_claim_documents',
      formData,
      {
        headers: {
          token,
          visitno: patient.visitNo,
          file_size: 0,
          doc_detail: JSON.stringify({
            document_details: docDetailsArray
          }),
        },
        httpsAgent,
      },
    );
    if (res.data.status === 'failed') {
      log(`${patient.name}: ${res.data.message}`);
      return;
    }
    log(patient.name, res.data);
  } catch (error) {
    log(`Error ${patient.visitNo}: Uploading documents`);
    if (axiosErrorHandler(error)) return;
    else {
      log(error);
      return;
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

    const names = await fs.readdir(resolve(config.folder, patientFolder));
    for (const name of names) {
      if (name === `${visitNo}.pdf`) continue;
      const pathname = resolve(config.folder, patientFolder, name);
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
          filenames[i] = resolve(pathname, filenames[i]);
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
    if (!patient[1]?.length || !patient[2]?.length) {
      log(`${patientFolder} does not have required parts 1 and 2`);
      continue;
    }
    patients.push(patient);
  }

  return patients;
}

async function getHook() {
  try {
    const hookRes = await axios.get('https://usama8800.net/server/kv/dg');
    if (hookRes.data.startsWith('http')) discordHook = hookRes.data;
  } catch (error) { /* empty */ }
}

function axiosErrorHandler(error: any): boolean {
  if (error.isAxiosError) {
    const err = error as AxiosError;
    if (err.code === 'ENOTFOUND' || err.code === 'ECONNRESET') {
      log('Internet problem');
    } else if (err.code === AxiosError.ETIMEDOUT) {
      log('Internet problem or website down. Try again');
    } else if ((err.status ?? 0) >= 500 && err.code === AxiosError.ERR_BAD_RESPONSE) {
      log('Bad response from website');
      log('Status', err.status);
      log('Code', err.code);
      if (err.response?.data) {
        log(err.response.data);
      }
    } else {
      log('Status', err.status);
      log('Code', err.code);
      if (err.response?.data) {
        log(err.response.data);
      }
    }
    return true;
  }
  return false;
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

if (require.main === module) {
  const date = dayjs().format();
  const header = `**MSK Statelife** @ _${os.userInfo().username}_ | _${os.hostname()}_: \`${date}\`\n`;
  const handler = async (reason: Error) => {
    console.log(reason);
    if (discordHook) {
      let content = reason.stack;
      if ((reason as any).isAxiosError) {
        const aErr = reason as AxiosError;
        content += `\n${JSON.stringify(aErr.toJSON(), null, 2)}`;
      }
      try {
        await axios.post(discordHook!, {
          content: `${header}\nUncaught Error\`\`\`${content}\`\`\``,
        });
      } catch (error) { /* empty */ }
    }
    process.exit(1);
  };
  process
    .on('unhandledRejection', handler)
    .on('uncaughtException', handler);
  if (process.argv.length > 2) {
    let patientsPath = process.argv.slice(2).join(' ');
    if (!patientsPath.startsWith('"') && patientsPath.endsWith('"'))
      patientsPath = patientsPath.slice(0, -1);
    patientsPath = patientsPath.replace(/\^([^^])?/g, '$1');
    config.folder = patientsPath;
  } else {
    // log('Folder not given. Using ./patients');
  }
  getHook();
  main().then(() => {
    writeFile(logFilePath, logFileData);
    if (discordHook) {
      axios.post(discordHook, {
        content: `${header}${logFileData}`,
      });
    }
  });
}
