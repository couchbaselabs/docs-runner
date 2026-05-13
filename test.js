'use strict';
import * as fs from "fs";
import path from "node:path";
import { promisify } from "util"
import * as cp from "child_process"

const exec = promisify(cp.exec)

const { stdout } = await exec(
    `droid exec "say hello"`)

console.log(stdout)