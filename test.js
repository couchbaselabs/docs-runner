'use strict';
import * as fs from "fs";
import path from "node:path";
import { promisify } from "util"
import * as cp from "child_process"

const exec = promisify(cp.exec)

const llm_model = process.env.LLM_MODEL || "claude-haiku-4-5-20251001"

const { stdout } = await exec(
    `droid exec "say hello"`)

console.log(stdout)

try {
  const { stdout } = await exec(
    `droid exec --auto medium -f review.md`)

  console.log(stdout)
} catch (error) {
  console.error(`Error executing droid: ${error}`);
  console.dir(error)
  process.exit(1);
}