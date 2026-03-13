'use strict';
import * as fs from "fs";
import path from "node:path";
import { Octokit } from "octokit"
import Handlebars from "handlebars";
import { diffString, diff } from 'json-diff';
import { strict as assert } from 'node:assert';
import { promisify } from "util"
import * as cp from "child_process"

const exec = promisify(cp.exec)

const content_path = process.env.CONTENT_PATH
const octokit = new Octokit({ auth: process.env.GH_TOKEN })

const head_sha = process.env.HEAD_SHA
const pull_request_number = process.env.PULL_REQUEST_NUMBER
const repository = process.env.REPOSITORY

const llm_model = process.env.LLM_MODEL || "claude-haiku-4-5-20251001"

import parseGitDiff from 'parse-git-diff';
 
function parseDiffFile(filePath) {
  const diffContent = fs.readFileSync(filePath, "utf-8")

  const diff = Object.fromEntries(parseGitDiff(diffContent)
    .files
    .filter(f => f.path.match(/\.(adoc|ya?ml)$/))
    .map(f => [f.path, f.chunks]))
  return ((file, line) => {
    // Check if the file is in the diff
    if (! diff[file]) return null;

    // Check if the line number is in the diff
    for (const chunk of diff[file]) {
      const {start, lines} = chunk.toFileRange;
      if (line >= start && line < (start + lines)) {
        return chunk.changes.find(c => c.lineAfter == line).content
      }
    }
    return null
  })
}

const inDiff = parseDiffFile("./diff.txt");

const vale = JSON.parse(fs.readFileSync('vale.json', "utf-8"))

const prep = Object.fromEntries(
  Object.entries(vale)
    .flatMap(([file, rules]) => {
      const rfiltered = rules.flatMap(r => {
        const Content = inDiff(file, r.Line)
        return (Content === null) ? [] : {...r, Content}
      })

      if (rfiltered.length) {
        const rulesByLine = Object.groupBy(rfiltered, r => r.Line)
        for (const k of Object.keys(rulesByLine)) {
          rulesByLine[k] = {
            rules: rulesByLine[k],
            pre: rulesByLine[k][0].Content
          }
        }
        return [[file, rulesByLine]]
      }
      else {
        return []
      }
    }))

fs.writeFileSync('vale-intermediate.json', JSON.stringify(prep), 'utf-8')

const { stdout } = await exec(
  `droid exec --auto medium --model ${llm_model} -f review.md`)

console.log(stdout)

const updated = JSON.parse(fs.readFileSync('vale-new.json', "utf-8"));

console.dir(updated)

console.dir(diff(prep, updated), {depth: 8})

  // TODO revise and reenable this sanity check:
  // for (const [equality, subobject] of diff(collected, updated)) {
  //   assert.equal(equality, '~', 'AI sanity check: expect altered sub-object')
  //   assert.deepEqual(Object.keys(subobject), ['new__added'], 'AI sanity check: only new field added')
  // }

const fence = "```"

const template = Handlebars.compile(
`Automated review comment from Vale and OpenAI using the ${llm_model} model:

  ${fence}suggestion
  {{{newContent}}}
  ${fence}
  
  Using these Vale rules:
  {{#each rules}}
  * {{#if this.Link}}[{{this.Check}}]({{this.Link}}){{else}}{{this.Check}}{{/if}} ({{this.Severity}}) - {{this.Message}} {{this.Description}}
  {{/each}}`)


// Fetch all comments on the pull request
const comments = await octokit.request(
  `GET /repos/${repository}/pulls/${pull_request_number}/comments`, 
  {
    per_page: 100, // see https://docs.github.com/en/rest/using-the-rest-api/using-pagination-in-the-rest-api?apiVersion=2022-11-28 for pagination TODO 
    headers: {
      'X-GitHub-Api-Version': '2022-11-28'
    }
  }
);

// Filter comments made by 'tech-comm-team-couchbase'
const techCommComments = comments.data.filter(comment => comment.user.login === 'tech-comm-team-couchbase');

// Delete each comment
// (we might want to https://docs.github.com/en/graphql/reference/mutations#resolvereviewthread instead, but that's GraphQL only, so for another day.)
await Promise.all(techCommComments.map(async (comment) => {
  await octokit.request(
    `DELETE /repos/${repository}/pulls/comments/${comment.id}`, 
    {
      headers: {
        'X-GitHub-Api-Version': '2022-11-28'
      }
    }
  );
}));

await Promise.all(updated.map(async (record) => {
  if (record.new !== record.pre) {
    console.log(record);
    console.log(`Line ${record.line} in file ${record.file} changed from "${record.pre}" to "${record.new}"`);

    console.log(record.file, record.line, record.new, record.rules);

    await postComment(record.file, record.line, record.new, record.rules);
  }
}));

async function postComment(file, line, newContent, rules) {

  const payload = template({rules, newContent})
  await octokit.request(
    `POST /repos/${repository}/pulls/${pull_request_number}/comments`, 
    {
    body: payload,
    commit_id: head_sha,
    path: path.join(content_path, file),
    line: parseInt(line),
    start_side: 'RIGHT',
    side: 'RIGHT',
    headers: {
      'X-GitHub-Api-Version': '2022-11-28'
    }
  })
}
