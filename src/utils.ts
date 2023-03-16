import * as PDFLib from 'pdf-lib';

export async function generatePDF(fileArray) {
  let allPagesCount = 0;
  const currentFileDetails: any[] = [];
  const mergedPdf = await PDFLib.PDFDocument.create();

  if (fileArray && fileArray != null && fileArray.length > 0) {
    const docTypes: string[] = [];
    fileArray.forEach(function (item) {
      const val = item.docType;
      if (docTypes.indexOf(val) < 0)
        docTypes.push(val);
    });

    for (const dt of docTypes) {
      const docTypeFiles = fileArray.filter(function (f) { return f.docType == dt; });
      const fDetail = {
        docType: dt,
        startPage: allPagesCount + 1,
        totalPages: 0,
      };
      for (const file of docTypeFiles) {
        if (file.fileType.indexOf('tiff') > -1 || file.fileType.indexOf('tif') > -1 || file.fileType.indexOf('pdf') > -1) {
          const document = await PDFLib.PDFDocument.load(file.fileData);

          const copiedPages = await mergedPdf.copyPages(document, document.getPageIndices());
          copiedPages.forEach((page) => {
            mergedPdf.addPage(page);
            allPagesCount++;
            fDetail.totalPages++;
          });
        }
        else {
          const jpgImage = await mergedPdf.embedJpg(file.fileData);
          const page = mergedPdf.addPage();
          allPagesCount++;
          fDetail.totalPages++;
          page.drawImage(jpgImage, {
            x: 0,
            y: 0,
            width: page.getWidth(),
            height: page.getHeight(),
          });
        }
      }
      currentFileDetails.push(fDetail);
    }
  }

  const pdfBytes = await mergedPdf.save();
  return { pdf: pdfBytes, pdfDetails: currentFileDetails, allPagesCount };
}

const cookies: any = {};
export function setCookies(headers) {
  if (!headers['set-cookie']) return;

  for (const cookiepies of headers['set-cookie']) {
    let cookieName: string | undefined = undefined;
    const cookiepie = cookiepies.split(';');
    for (const cookie of cookiepie) {
      const [key, val] = cookie.split('=');
      if (!cookieName) {
        cookieName = key.trim();
        cookies[cookieName!] = {
          value: val ?? true
        };
      } else {
        cookies[cookieName][key.trim()] = val ?? true;
      }
    }
  }
  return cookies;
}

export function getCookieValue(...cookieNames: string[]) {
  let ret = '';
  for (const cookieName of cookieNames) {
    ret += `${cookieName}=${cookies[cookieName].value}; `;
  }
  return ret;
}
