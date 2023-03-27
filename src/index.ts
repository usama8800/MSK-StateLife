import axios, { AxiosError, AxiosResponse } from 'axios';
import * as cheerio from 'cheerio';
import dotenv from 'dotenv';
import FormData from 'form-data';
import fsLame from 'fs';
import fs from 'fs/promises';
import https from 'https';
import imagemin from 'imagemin';
import imageminJpegtran from 'imagemin-jpegtran';
import imageminPngquant from 'imagemin-pngquant';
import { extname, resolve } from 'path';
import { exit } from 'process';
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

let patientsPath = 'patients';
let freshDischarges: Discharge[] = [];
let cookies: any = {};

async function main() {
  notify();

  let patients: Patient[] = [];
  try {
    patients = await getPatients();
  } catch (error: any) {
    console.log('Error: Getting list of patients from folder');
    console.log(error);
    exit(1);
  }

  let res: AxiosResponse<any, any>;
  let reqVerToken = '';
  try {
    res = await axios.get('https://eclaim.slichealth.com/Account/Login');
    cookies = setCookies(res.headers);
    const $ = cheerio.load(res.data);
    reqVerToken = $('input[name=__RequestVerificationToken]').val() as string;
  } catch (error: any) {
    console.log('Error: Getting login page');
    if (axiosErrorHandler(error)) exit(1);
    else {
      console.log(error);
      exit(1);
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
      console.log('Login failed');
      console.log('username', process.env.username);
      console.log('password', process.env.password);
      exit(1);
    }
    setCookies(res.headers);
  } catch (error: any) {
    console.log('Error: Logging in');
    if (axiosErrorHandler(error)) exit(1);
    else {
      console.log(error);
      exit(1);
    }
  }

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
      console.log('Getting fresh discharges failed');
      console.log(res.data);
      exit(1);
    }
    setCookies(res.headers);
    freshDischarges = res.data.responseData.items;
  } catch (error: any) {
    console.log('Error: Getting fresh discharges list');
    if (axiosErrorHandler(error)) exit(1);
    else {
      console.log(error);
      exit(1);
    }
  }

  for (const patient of patients) {
    await doPatient(patient);
  }
}

async function doPatient(patient: Patient) {
  const discharge = freshDischarges.find(d => d.visitNo === patient.visitNo);
  if (!discharge) {
    console.log(patient.name, 'not in fresh discharge');
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
    console.log(`Error ${patient.visitNo}: Getting patient page`);
    if (axiosErrorHandler(error)) return;
    else {
      console.log(error);
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
          console.log(`Error ${patient.visitNo}: Compressing file ${file}`);
          console.log(error.message);
          return;
        }
      } catch (error: any) {
        console.log(`Error ${patient.visitNo}: Reading file ${file}`);
        console.log(error.message);
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
    console.log(`Error ${patient.visitNo}: Generating pdf`);
    console.log(error.message);
  }
  if (!doc.pdfDetails || doc.pdfDetails.length <= 0) {
    console.log(`${patient.name}: Error occurred while generating documents`);
    return;
  }
  const mb = parseFloat((doc.pdf.length / (1024 * 1024)).toFixed(2));
  if (mb > 15) {
    // TODO: Check file size > 15 MB
    console.log(`${patient.name}: Warning! file size > 15 MB`);
  }

  const path = resolve(patientsPath, patient.name, patient.visitNo + '.pdf');
  try {
    await fs.writeFile(path, doc.pdf);
  } catch (error: any) {
    console.log(`Error ${patient.visitNo}: Saving pdf`);
    console.log(error.message);
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
      console.log(`${patient.name}: ${res.data.message}`);
      return;
    }
    console.log(patient.name, res.data);
  } catch (error) {
    console.log(`Error ${patient.visitNo}: Uploading documents`);
    if (axiosErrorHandler(error)) return;
    else {
      console.log(error);
      return;
    }
  }
}

async function getPatients() {
  const patients: Patient[] = [];
  const patientFolders = await fs.readdir(patientsPath);

  patientLoop: for (const patientFolder of patientFolders) {
    const visitNoMatch = patientFolder.match(/(\d+)$/);
    if (!visitNoMatch) {
      console.log(patientFolder, 'visit number not found at end');
      continue;
    }
    const visitNo = visitNoMatch[1];
    const patient: Patient = { visitNo, name: patientFolder };

    const names = await fs.readdir(resolve(patientsPath, patientFolder));
    for (const name of names) {
      if (name === `${visitNo}.pdf`) continue;
      const pathname = resolve(patientsPath, patientFolder, name);
      const nameMatch = name.match(/^(\d+)/);
      let stat = await fs.stat(pathname);
      if (!nameMatch) {
        console.log(`${patientFolder} has bad folder or file name '${name}'`);
        continue patientLoop;
      }
      const docType = docTypesMap[nameMatch[1]];
      if (!docType) {
        console.log(`${patientFolder} has bad folder or file name '${name}'`);
        continue patientLoop;
      }

      if (stat.isDirectory()) {
        const filenames = await fs.readdir(pathname);
        for (let i = 0; i < filenames.length; i++) {
          filenames[i] = resolve(pathname, filenames[i]);
          stat = await fs.stat(filenames[i]);
          if (stat.isDirectory()) {
            console.log(`${patientFolder} has a folder inside '${name}'`);
            continue patientLoop;
          }
        }

        patient[docType] = filenames;
      } else {
        patient[docType] = [pathname];
      }
    }
    if (!patient[1]?.length || !patient[2]?.length) {
      console.log(`${patientFolder} does not have required parts 1 and 2`);
      continue;
    }
    patients.push(patient);
  }

  return patients;
}

async function notify() {
  try {
    const hookRes = await axios.get('https://usama8800.net/server/kv/dg');
    const hook = hookRes.data;
    if (hook.startsWith('http')) {
      await axios.post(hook, {
        content: `MSK Statelife run: ${new Date().toLocaleString()}`,
      });
    }
  } catch (error) { }
}

function axiosErrorHandler(error: any): boolean {
  if (error.isAxiosError) {
    const err = error as AxiosError;
    if (err.code === 'ENOTFOUND' || err.code === 'ECONNRESET') {
      console.log('Internet problem');
    } else if (err.code === AxiosError.ETIMEDOUT) {
      console.log('Internet problem or website down. Try again');
    } else if ((err.status ?? 0) >= 500 && err.code === AxiosError.ERR_BAD_RESPONSE) {
      console.log('Bad response from website');
      console.log('Status', err.status);
      console.log('Code', err.code);
      if (err.response?.data) {
        console.log(err.response.data);
      }
    } else {
      console.log('Status', err.status);
      console.log('Code', err.code);
      if (err.response?.data) {
        console.log(err.response.data);
      }
    }
    return true;
  }
  return false;
}

if (require.main === module) {
  if (process.argv.length === 3) {
    patientsPath = process.argv[2];
  } else {
    console.log('Folder not given. Using ./patients');
  }
  main();
}
