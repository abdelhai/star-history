import http from "http";
import Koa from "koa";
import Router from "koa-router";
import { JSDOM } from "jsdom";
import XYChart from "../packages/xy-chart";
import {
  convertStarDataToChartData,
  DEFAULT_MAX_REQUEST_AMOUNT,
  getReposStarData,
} from "../common/chart";
import api from "../common/api";
import { getRepoStarDataCache, setRepoStarDataCache } from "./cache";
import { replaceSVGContentFilterWithCamelcase } from "./utils";
import { getNextToken, initTokenFromEnv } from "./token";
import { ChartMode } from "../types/chart";

const startServer = async () => {
  await initTokenFromEnv();

  const app = new Koa();
  const router = new Router();

  // Example request link:
  // /svg?repos=bytebase/star-history&type=Date
  router.get("/svg", async (ctx) => {
    const repos = `${ctx.query["repos"]}`.split(",");
    let type = `${ctx.query["type"]}` as ChartMode;

    if (!["Date", "Timeline"].includes(type)) {
      type = "Date";
    }

    if (repos.length === 0) {
      ctx.throw(400, `${http.STATUS_CODES[400]}: Repos required`);
      return;
    }

    const token = getNextToken();
    const reposStarData = [];
    const nodataRepos = [];

    for (const repo of repos) {
      const cacheData = getRepoStarDataCache(repo);

      if (cacheData) {
        try {
          // Get the real-time repo star amount. If its value equal the cache, use the cached data.
          const starAmount = await api.getRepoStargazersCount(repo, token);

          if (starAmount === cacheData.starAmount) {
            reposStarData.push({
              repo,
              starRecords: cacheData.starRecords,
            });
            continue;
          }
        } catch (error) {
          console.error(error);
        }
      }

      nodataRepos.push(repo);
    }

    try {
      // We can reduce the request amount by setting maxRequestAmount,
      // the value is the same as the frontend.
      const data = await getReposStarData(
        nodataRepos,
        token,
        DEFAULT_MAX_REQUEST_AMOUNT
      );
      for (const d of data) {
        setRepoStarDataCache(d.repo, {
          starRecords: d.starRecords,
          starAmount: d.starRecords[d.starRecords.length - 1].count,
          lastUsedAt: Date.now(),
        });
        reposStarData.push(d);
      }
    } catch (error: any) {
      console.error("Failed to request data, error: ", error);
      const status = error.status || 400;
      const message =
        error.message || "Some unexpected error happened, try again later";

      ctx.throw(status, `${http.STATUS_CODES[status]}: ${message}`);
      return;
    }

    const dom = new JSDOM(`<!DOCTYPE html><body></body>`);
    const body = dom.window.document.querySelector("body");
    const svg = dom.window.document.createElement(
      "svg"
    ) as unknown as SVGSVGElement;

    if (!dom || !body || !svg) {
      ctx.throw(
        500,
        `${http.STATUS_CODES[500]}: Failed to mock dom with JSDOM`
      );
      return;
    }

    body.append(svg);

    const defaultSVGWidth = "600";
    const defaultSVGHeight = "400";
    svg.setAttribute("width", defaultSVGWidth);
    svg.setAttribute("height", defaultSVGHeight);
    svg.setAttribute("xmlns", "http://www.w3.org/2000/svg");

    try {
      XYChart(
        svg,
        {
          title: "Star history",
          xLabel: type === "Date" ? "Date" : "Timeline",
          yLabel: "GitHub Stars",
          data: convertStarDataToChartData(reposStarData, type),
          showDots: false,
        },
        {
          xTickLabelType: type === "Date" ? "Date" : "Number",
        }
      );
    } catch (error) {
      ctx.throw(
        500,
        `${http.STATUS_CODES[500]}: Failed to generate chart, ${error}`
      );
      return;
    }

    const svgContent = replaceSVGContentFilterWithCamelcase(svg.outerHTML);

    const now = new Date();
    ctx.type = "image/svg+xml;charset=utf-8";
    ctx.set("cache-control", "no-cache");
    ctx.set("date", `${now}`);
    ctx.set("expires", `${now}`);
    ctx.body = svgContent;
  });

  app.on("error", (err) => {
    console.error("server error: ", err);
  });

  app.use(router.routes()).use(router.allowedMethods());

  app.listen(8080, () => {
    console.log(`app listening on port ${8080}!`);
  });
};

startServer();
