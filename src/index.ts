import axios from 'axios';
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
  const patients = await getPatients();

  let res = await axios.get('https://eclaim.slichealth.com/Account/Login');
  cookies = setCookies(res.headers);
  const $ = cheerio.load(res.data);
  const reqVerToken = $('input[name=__RequestVerificationToken]').val();

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
  if (!res.data.success) exit(1);
  setCookies(res.headers);

  res = await axios.post('https://eclaim.slichealth.com/Upload/GetFreshDischarges', {}, {
    headers: {
      cookie: getCookieValue(
        Object.keys(cookies).find(x => x.includes('Antiforgery'))!,
        '.AspNetCore.Cookies',
      ),
    }
  });
  if (!res.data.success) exit(2);
  setCookies(res.headers);

  freshDischarges = res.data.responseData.items;
  for (const patient of patients) {
    await doPatient(patient);
  }
}

async function doPatient(patient: Patient) {
  console.log(patient.visitNo: patient.name);
  const discharge = freshDischarges.find(d => d.visitNo === patient.visitNo);
  if (!discharge) {
    console.log(patient.name, 'not in fresh discharge');
    return;
  }

  let res = await axios.get('https://eclaim.slichealth.com/Upload/EditFreshDischarge?visitNo=' + patient.visitNo, {
    headers: {
      cookie: getCookieValue(
        Object.keys(cookies).find(x => x.includes('Antiforgery'))!,
        '.AspNetCore.Cookies',
      ),
    }
  });
  let token = res.data as string;
  let index = token.indexOf('apiAccessToken');
  token = token.slice(index + 'apiAccessToken = \''.length);
  index = token.indexOf('\'');
  token = token.slice(0, index);

  const files: any[] = [];
  for (const docType of Object.values(docTypesMap)) {
    for (const file of patient[docType] ?? []) {
      const f = await fs.readFile(file);
      const compressed = await imagemin.buffer(Buffer.from(f.buffer), {
        plugins: [
          imageminJpegtran(),
          imageminPngquant({
            quality: [0.6, 0.8]
          })
        ]
      });
      files.push({
        fileData: compressed.toString('base64'),
        docType,
        fileType: extname(file),
      });
    }
  }
  files.sort((a, b) => a.docType - b.docType || b.docType - a.docType);
  const doc = await generatePDF(files);
  if (!doc.pdfDetails || doc.pdfDetails.length <= 0) {
    console.log(`${patient.name}: Error occurred while generating documents`);
    return;
  }
  const mb = parseFloat((doc.pdf.length / (1024 * 1024)).toFixed(2));
  if (mb > 15) {
    // TODO: Check file size > 15 MB
    console.log(`${patient.name}: Warning! file size > 15 MB`);
  }

  const path = resolve('patients', patient.name, patient.visitNo + '.pdf');
  await fs.writeFile(path, doc.pdf);
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

  res = await axios.post('https://apps.slichealth.com/ords/ihmis_admin/eClaims/upload_claim_documents',
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
}

async function getPatients() {
  const patients: Patient[] = [];
  const patientFolders = await fs.readdir(patientsPath);

  patientLoop: for (const patientFolder of patientFolders) {
    const visitNoMatch = patientFolder.match(/.+?(\d+)/);
    if (!visitNoMatch) {
      console.log(patientFolder, 'visit number not found at end');
      continue;
    }
    const visitNo = visitNoMatch[1];
    const patient: Patient = { visitNo, name: patientFolder };

    const names = await fs.readdir(resolve(patientsPath, patientFolder));
    for (const name of names) {
      const pathname = resolve(patientsPath, patientFolder, name);
      const nameMatch = name.match(/^(\d+)/);
      const stat = await fs.stat(pathname);
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
        patient[docType] = filenames.map(f => resolve(pathname, f));
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

if (require.main === module) {
  if (process.argv.length === 3) {
    patientsPath = process.argv[2];
  } else {
    console.log('Folder not given. Using ./patients');
  }
  main();
}
