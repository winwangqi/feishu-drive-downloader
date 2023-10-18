import puppeteer, { Browser } from "puppeteer";
import * as cheerio from "cheerio";
import Bluebird from "bluebird";
import path from "path";
import fs from "fs";
import cliProgress from "cli-progress";
import minimist from "minimist";
import joi from "joi";

// https://wvp254x25u.feishu.cn/drive/folder/fldcnvnvLffFsGanijBDYRXfNVh

const SLEEP_TIME = 300;

// ================================================

const getUrlByPathname = (url: string, pathname: string) => {
  const u = new URL(url);
  return u.origin + pathname;
};

const isFolder = (url: string) => url.includes("/folder");

const isFile = (url: string) => url.includes("/file");

const bytesToMB = (bytes: number) => {
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
};

const sleep = async (ms: number) => {
  return new Promise((resolve) => setTimeout(resolve, ms));
};

// ================================================

const context: { browser: Browser } = {
// @ts-ignore
  browser: undefined,
};

// ================================================
async function main(url?: string) {
  const argvSchema = joi.object({
    _: joi.any(),
    url: joi.string().uri().required(),
    headless: joi.boolean(),
  });

  const argv = minimist<{ url: string; headless: boolean }>(
    process.argv.slice(2),
  );

  const { error, value } = argvSchema.validate(argv);

  if (error) {
    throw error;
  }

  console.log("Start 🚀");

  await initContext(argv.headless);
  await parseFolder(argv.url);

  console.log("Done ✅");

  await context.browser.close();
}

// ================================================

async function initContext(headless: boolean) {
  context.browser = await puppeteer.launch({
    timeout: 0,
    headless: headless ? "new" : false,
    handleSIGINT: false,
    handleSIGHUP: false,
    handleSIGTERM: false,
  });
}

// ================================================

async function parseFolder(folderUrl: string) {
  const { browser } = context;
  const page = await browser.newPage();
  await page.goto(folderUrl);
  await sleep(SLEEP_TIME);
  await page.waitForNetworkIdle();

  const html = await page.content();

  const $ = cheerio.load(html);

  const breadcrumb = $(
    ".explorer-path-breadcrumb .explorer-path-breadcrumb-item",
  )
    .toArray()
    .map((element) => {
      return $(element).find(".explorer-path-breadcrumb-item__link >").text();
    });

  const currentPath = `${breadcrumb.join("/")}`;

  console.log(`Start to parse folder: ${currentPath}`);

  const items = $(".file-item-link")
    .toArray()
    .map((element) => {
      const $element = $(element);
      const pathname = $element.attr("href") || '';
      return {
        name: $element.find("span[type='main']").text(),
        url: getUrlByPathname(folderUrl, pathname),
      };
    });

  await Bluebird.mapSeries(items, async (item) => {
    const { url, name } = item;

    if (isFolder(url)) {
      await parseFolder(url);
    }

    if (isFile(url)) {
      const fileFullPath = path.join(currentPath, name);

      if (!fs.existsSync(fileFullPath)) {
        await parseFile(url, name, currentPath);
      }
    }
  });

  await page.close();
}

// ================================================

async function parseFile(
  fileUrl: string,
  fileName: string,
  downloadPath: string,
) {
  const { browser } = context;
  const page = await browser.newPage();
  await page.goto(fileUrl);
  await sleep(SLEEP_TIME);
  await page.waitForNetworkIdle();

  const client = await page.target().createCDPSession();
  await client.send("Page.setDownloadBehavior", {
    behavior: "allow",
    downloadPath: path.join("./download", downloadPath),
  });

  await page.click(".suite-download-btn");

  await new Promise((resolve, reject) => {
    console.log(
      `Start to download file: [${path.join(downloadPath, fileName)}]`,
    );

    const bar = new cliProgress.SingleBar({
      format: `{bar} | {percentage}% | {valueMB} / {totalMB} | {eta}s`,
      hideCursor: true,
    });
    bar.start(Infinity, 0, {
      valueMB: "",
      totalMB: "",
    });

    // @ts-ignore
    page._client().on("Page.downloadProgress", async (event) => {
      if (event.state === "inProgress") {
        bar.setTotal(event.totalBytes);
        bar.update(event.receivedBytes);
        bar.update({
          valueMB: bytesToMB(event.receivedBytes),
          totalMB: bytesToMB(event.totalBytes),
        });
      }

      if (event.state === "completed") {
        bar.stop();
        resolve(fileName);
      }

      if (event.state === "canceled") {
        bar.stop();
        reject({
          fileName,
          state: event.state,
        });
      }
    });
  });

  await page.close();
}

main();
