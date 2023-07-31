import dotenv from 'dotenv';
import path from 'path';
import puppeteer from 'puppeteer';
import { fileURLToPath } from 'url';

dotenv.config({ override: true });
const __dirname = fileURLToPath(new URL('.', import.meta.url));

// Launch the browser and open a new blank page
const browser = await puppeteer.launch({
  headless: process.env.MODE === 'dev' ? false : 'new',
});
const page = await browser.newPage();
const client = await page.target().createCDPSession();
await client.send('Page.setDownloadBehavior', {
  behavior: 'allow',
  downloadPath: path.normalize(path.resolve(__dirname, '..')),
});

await page.goto('https://apps.slichealth.com/ords/ihmis_admin/r/eclaim-upload/home');

await page.type('#P9999_USERNAME', process.env.username!);
await page.type('#P9999_PASSWORD', process.env.password!);
await Promise.all([
  page.click('button[id]'),
  page.waitForNavigation(),
]);

let selector = '#t_Button_navControl';
await page.waitForSelector(selector);
await page.click(selector, { delay: 100, offset: { x: 10, y: 10 } });

selector = '//a[contains(text(), \'Eclaim Upload\')]';
await page.waitForXPath(selector);
const [eclaimButton] = await page.$x(selector);
if (!eclaimButton) throw new Error('Eclaim Upload button not found');
await Promise.all([
  eclaimButton.evaluate(b => b.click()),
  page.waitForNavigation(),
]);

selector = '#freshCase_actions_button';
await page.waitForSelector(selector);
// await new Promise(resolve => setTimeout(resolve, 1000));
await page.click(selector, { delay: 100, offset: { x: 10, y: 10 } });

selector = '#freshCase_actions_menu_12i';
await page.waitForSelector(selector);
await page.click(selector);

selector = '//button[contains(text(), \'Download\')]';
await page.waitForXPath(selector);
const [downloadButton1] = await page.$x(selector);
if (!downloadButton1) throw new Error('Download button not found');
await downloadButton1.evaluate(b => b.click());

selector = '//*[@id="t_PageBody"]/div[12]/div[3]/div/button[2]';
await page.waitForXPath(selector);
const [downloadButton2] = await page.$x(selector);
if (!downloadButton2) throw new Error('Download button not found');
await downloadButton2.evaluate(b => b.click());

if (process.env.MODE !== 'dev') await browser.close();
