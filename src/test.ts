import { convertWordFiles } from 'convert-multiple-files';
import fsE from 'fs-extra';
import fsP from 'fs/promises';
import os from 'os';
import path from 'path';
import * as PDFLib from 'pdf-lib';
import { fileURLToPath } from 'url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
async function test() {
  const mergedPdf = await PDFLib.PDFDocument.create();
  const filepath = path.resolve(__dirname, '..', 'tmp.docx');
  const tmpPath = path.resolve(os.tmpdir(), 'tmp.docx');
  await fsP.copyFile(filepath, tmpPath);
  await fsE.remove(path.resolve(os.tmpdir(), 'tmp.pdf'));
  const newFile = await convertWordFiles(tmpPath, 'pdf', os.tmpdir());
  const exists = await fsE.exists(newFile);
  if (!exists) {
    console.log('Converted pdf does not exist');
    return;
  }
  await fsP.copyFile(newFile, path.resolve(__dirname, '..', 'tmp.pdf'));
  const newFile1 = path.resolve(__dirname, '..', 'tmp.pdf');
  const pdf = await fsP.readFile(newFile1);
  const document = await PDFLib.PDFDocument.load(pdf);
  const copiedPages = await mergedPdf.copyPages(document, document.getPageIndices());
  copiedPages.forEach((page) => mergedPdf.addPage(page));
  const pdfBytes = await mergedPdf.save();
  await fsP.writeFile(path.resolve(__dirname, '..', 'new.pdf'), pdfBytes);
}

test();
