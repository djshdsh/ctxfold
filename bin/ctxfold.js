#!/usr/bin/env node
/**
 * ctxfold CLI 入口。
 *
 * 退出码：0 成功 / 1 执行失败或自检未通过 / 2 用法错误。
 */

import { main } from "../lib/commands.js";

main(process.argv)
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error) => {
    process.stderr.write(`${error && error.stack ? error.stack : error}\n`);
    process.exitCode = 1;
  });
