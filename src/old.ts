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
import fetch, { Response } from 'node-fetch';
import * as os from 'os';
import { extname, resolve } from 'path';
import { exit } from 'process';
import { URL } from 'url';
import * as XLSX from 'xlsx';
import { formInputs, generatePDF, getCookieValue, setCookies } from './utils.js';

dotenv.config({ override: true });

interface PageJSON {
  pageItems: null | {
    itemsToSubmit: {
      n: string;
      v: string | string[];
      ck?: string;
    }[];
    protected: string;
    rowVersion: string;
    formRegionChecksums: string[];
  };
  salt: string;
}

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
const domain = 'https://apps.slichealth.com';
const baseURL1 = domain + '/ords';
const baseURL2 = baseURL1 + '/ihmis_admin/r/eclaim-upload';

async function main() {
  let res: Response;
  let sessionId = '';
  try {
    // Get Session Id
    res = await fetch(baseURL2 + '/home', {
      redirect: 'manual',
    });
    if (res.status >= 400) throw new Error('Get Session Id: Bad response');
    if (res.status !== 302) throw new Error('Get Session Id: Not Redirected');
    cookies = setCookies(res.headers.raw());
    sessionId = new URL(res.headers.get('location')!).searchParams.get('session')!;

    // Login Page
    res = await fetch(`${baseURL2}/login?session=${sessionId}`, {
      redirect: 'manual',
      headers: {
        cookie: getCookieValue(Object.keys(cookies).find(x => x.startsWith('ORA_'))!),
      },
    });
    if (res.status >= 400) throw new Error('Login Page: Bad response');
    let html = await res.text();
    let $ = cheerio.load(html);
    let inputs = formInputs($('#wwvFlowForm input'));

    // Login
    let json: PageJSON = {
      pageItems: {
        itemsToSubmit: [{
          n: 'P0_SPID',
          v: '',
          ck: inputs.find(x => x.for === 'P0_SPID')!.value,
        }, {
          n: 'P0_SUPER_ID',
          v: '',
          ck: inputs.find(x => x.for === 'P0_SUPER_ID')!.value,
        }, {
          n: 'P9999_USERNAME',
          v: process.env.username!,
        }, {
          n: 'P9999_PASSWORD',
          v: process.env.password!,
        }],
        formRegionChecksums: JSON.parse(inputs.find(x => x.id === 'pPageFormRegionChecksums')!.value),
        protected: inputs.find(x => x.id === 'pPageItemsProtected')!.value,
        rowVersion: inputs.find(x => x.id === 'pPageItemsRowVersion')!.value,
      },
      salt: inputs.find(x => x.id === 'pSalt')!.value,
    };
    let form = new URLSearchParams();
    form.append('p_flow_id', inputs.find(x => x.id === 'pFlowId')!.value);
    form.append('p_flow_step_id', inputs.find(x => x.id === 'pFlowStepId')!.value);
    form.append('p_instance', inputs.find(x => x.id === 'pInstance')!.value);
    form.append('p_debug', '');
    form.append('p_request', 'LOGIN');
    form.append('p_reload_on_submit', 'S');
    form.append('p_page_submission_id', inputs.find(x => x.id === 'pPageSubmissionId')!.value);
    form.append('p_json', JSON.stringify(json));
    res = await fetch(baseURL1 + '/wwv_flow.accept', {
      method: 'POST',
      body: form,
      headers: {
        cookie: getCookieValue(Object.keys(cookies).find(x => x.startsWith('ORA_'))!),
      },
    });
    if (res.status >= 400) throw new Error('Log In: Bad response');
    cookies = setCookies(res.headers.raw());

    // EClaim Upload page
    res = await fetch(`${baseURL2}/fresh-cases?session=${sessionId}`, {
      headers: {
        cookie: getCookieValue(Object.keys(cookies).find(x => x.startsWith('ORA_'))!),
      },
    });
    if (res.status >= 400) throw new Error('EClaim Upload Page: Bad response');
    html = await res.text();
    await fs.writeFile('x.html', html);
    $ = cheerio.load(html);
    inputs = formInputs($('#wwvFlowForm input'));
    let i = html.indexOf('ajaxIdentifier');
    if (i === -1) throw new Error('Fresh Cases: No plugin id');
    html = html.slice(i + 'ajaxIdentifier'.length + 3);
    i = html.indexOf('"');
    const freshPluginId = html.slice(0, i);
    i = html.indexOf('apex.jQuery(\'#');
    if (i === -1) throw new Error('Objected Cases: No div id');
    html = html.slice(i + 'apex.jQuery(\''.length);
    i = html.indexOf('\'');
    const objectedDivId = html.slice(0, i);
    i = html.indexOf('ajaxIdentifier');
    if (i === -1) throw new Error('Objected Cases: No plugin id');
    html = html.slice(i + 'ajaxIdentifier'.length + 3);
    i = html.indexOf('"');
    const objectedPluginId = html.slice(0, i);
    i = html.indexOf('ajaxIdentifier');
    if (i === -1) throw new Error('Discharged Cases: No plugin id');
    html = html.slice(i + 'ajaxIdentifier'.length + 3);
    i = html.indexOf('"');
    const dischargedPluginId = html.slice(0, i);

    json = {
      pageItems: null,
      salt: inputs.find(x => x.id === 'pSalt')!.value,
    };
    form = new URLSearchParams();
    form.append('p_flow_id', inputs.find(x => x.id === 'pFlowId')!.value);
    form.append('p_flow_step_id', inputs.find(x => x.id === 'pFlowStepId')!.value);
    form.append('p_instance', inputs.find(x => x.id === 'pInstance')!.value);
    form.append('p_debug', '');
    form.append('p_request', `PLUGIN=${freshPluginId}`);
    form.append('p_widget_name', 'worksheet');
    // form.append('p_widget_mod', 'CONTROL');
    // form.append('p_widget_action', 'SHOW_DOWNLOAD');
    form.append('p_widget_mod', 'ACTION');
    form.append('p_widget_action', 'PAGE');
    form.append('p_widget_action_mod', 'pgR_min_row=101max_rows=50rows_fetched=50');
    form.append('p_widget_num_return', '50');
    form.append('x01', inputs.find(x => x.id === 'freshCase_worksheet_id')!.value);
    form.append('x02', inputs.find(x => x.id === 'freshCase_report_id')!.value);
    form.append('p_json', JSON.stringify(json));
    console.log(form.get('p_request'));
    res = await fetch('https://apps.slichealth.com/ords/wwv_flow.ajax', {
      method: 'POST',
      body: form,
      headers: {
        cookie: getCookieValue(Object.keys(cookies).find(x => x.startsWith('ORA_'))!),
        'Content-Length': `${form.toString().length}`,
        'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
        Accept: 'text/html, */*; q=0.01',
        'Accept-Encoding': 'gzip, deflate, br',
        'Accept-Language': 'en-US,en;q=0.9,ar;q=0.8',
        Connection: 'keep-alive',
        Host: 'apps.slichealth.com',
        Origin: 'https://apps.slichealth.com',
        Referer: 'https://apps.slichealth.com/',
        'Sec-Ch-Ua': '"Not.A/Brand";v="8", "Chromium";v="114", "Google Chrome";v="114"',
        'Sec-Ch-Ua-Mobile': '?0',
        'Sec-Ch-Ua-Platform': '"Windows"',
        'Sec-Fetch-Dest': 'empty',
        'Sec-Fetch-Mode': 'cors',
        'Sec-Fetch-Site': 'same-origin',
        UserAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/114.0.0.0 Safari/537.36',
        'X-Requested-With': 'XMLHttpRequest',
      },
    });
    console.log(res.status, res.statusText, res.headers);
    if (res.status >= 400) throw new Error('Fresh Cases: Bad response');
    html = await res.text();
    await fs.writeFile('y.html', html);

    form.set('p_widget_mod', 'ACTION');
    form.set('p_widget_action', 'GET_DOWNLOAD_LINK');
    form.append('f01', 'freshCase_download_format');
    form.append('f01', 'freshCase_plain');
    form.append('f01', 'freshCase_pdf_page_size');
    form.append('f01', 'freshCase_pdf_orientation');
    form.append('f01', 'freshCase_accessible');
    form.append('f02', 'CSV');
    form.append('f02', '');
    form.append('f02', 'LETTER');
    form.append('f02', 'HORIZONTAL');
    form.append('f02', '');
    res = await fetch(baseURL1 + '/wwv_flow.ajax', {
      method: 'POST',
      body: form,
      headers: {
        cookie: getCookieValue(Object.keys(cookies).find(x => x.startsWith('ORA_'))!),
      },
    });
    if (res.status >= 400) throw new Error('Fresh Cases: Bad response');
    html = await res.text();
    await fs.writeFile('z.html', html);
  } catch (error: any) {
    log(error);
    return;
  }
  if (1) exit(0);

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

const date = dayjs().format();
const header = `**MSK Statelife** @ _${os.userInfo().username}_ | _${os.hostname()}_: \`${date}\`\n`;
const c = '```';
let handlingSigInt = false;
const handler = async (reason: any) => {
  if (handlingSigInt) return;
  if (!reason.isSigInt) console.log(reason);
  if (reason.isSigInt) handlingSigInt = true;
  if (discordHook && process.env.MODE !== 'dev') {
    let content = reason.isSigInt ? `SIGINT\n${c}${logFileData}${c}` : `Uncaught Error\n${c}${reason.stack}${c}`;
    if ((reason as any).isAxiosError) {
      const aErr = reason as AxiosError;
      content += `\n${c}${JSON.stringify(aErr.toJSON(), null, 2)}${c}`;
    }
    try {
      await axios.post(discordHook!, {
        content: `${header}\n${content}`,
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
  writeFile(logFilePath, logFileData);
  if (discordHook && process.env.MODE !== 'dev') {
    axios.post(discordHook, {
      content: `${header}${logFileData}`,
    });
  }
});
