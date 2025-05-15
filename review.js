'use strict';
import OpenAI from "openai";
import * as fs from "fs";
import { Octokit } from "octokit"
import Handlebars from "handlebars";
import { diffString, diff } from 'json-diff';
import { strict as assert } from 'node:assert';


const octokit = new Octokit({ auth: process.env.GH_TOKEN })
const openai = new OpenAI();

const head_sha = process.env.HEAD_SHA
const pull_request_number = process.env.PULL_REQUEST_NUMBER
const repository = process.env.REPOSITORY
const openai_model = process.env.OPENAI_MODEL || "gpt-4o-mini"

import parseGitDiff from 'parse-git-diff';
 
function parseDiffFile(filePath) {
  const diffContent = fs.readFileSync(filePath, "utf-8")

  const diff = Object.fromEntries(parseGitDiff(diffContent)
    .files
    .filter(f => f.path.match(/\.adoc$/))
    .map(f => [f.path, f.chunks]))
  console.dir(diff, {depth: 4})
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

const v2 = Object.fromEntries(
  Object.entries(vale)
    .flatMap(([file, rules]) => {
      const rfiltered = rules.flatMap(r => {
        const Content = inDiff(file, r.Line)
        console.log({Content, file, r})
        return (Content === null) ? [] : {...r, Content}
      })
      console.log("rfiltered", rfiltered)

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

    console.log(2, v2)

// Step 2: Create an Assistant (once)
const assistant = await openai.beta.assistants.create({
  name: "Couchbase Style guide assistant",
  instructions: 
    `Analyze a line of documentation in Asciidoc format and a JSON containing reports from Vale (a style-guide linter) about that line, to recommend content edits. 
    When you find a Vale recommendation, you should apply it to the line, but only if it makes sense in that context.
    Recommend a change only where the change is appropriate. 
    Recommend a change only where the changed text differs from the original text.
    Remember that the line is in Asciidoc format, so you should keep the Asciidoc formatting (unless the Vale rule is specifically about Asciidoc formatting).
    Remember that Couchbase is a database product, and in some cases, the recommendation may not be appropriate for a database context.
    Don't truncate the line with '...', return the whole string in full.
    If you didn't find any issues, return the original line.
    If your edit makes the sentence ungrammatical or just "worse", give up and return the original line.
    To avoid making the diffs too big, don't add or remove any spaces.
    Do add newlines if the style guide rule requests 'ventilated prose'.
    Return just the line, without the backticks to format the asciidoc code.`,
  model: openai_model,
  tools: [{ type: "file_search" }]
}); 

// Step 3: Create a thread
const thread = await openai.beta.threads.create();

const fence = "```"

const template = Handlebars.compile(
`Automated review comment from Vale and OpenAI using the ${openai_model} model:

  ${fence}suggestion
  {{{newContent}}}
  ${fence}
  
  Using these Vale rules:
  {{#each rules}}
  * {{#if this.Link}}[{{this.Check}}]({{this.Link}}){{else}}{{this.Check}}{{/if}} ({{this.Severity}}) - {{this.Message}} {{this.Description}}
  {{/each}}`)



for (const [file, lines] of Object.entries(v2)) {
  const collected = []

  for (const [line, record] of Object.entries(lines)) {
    collected.push({line, ...record})
  }

  const payload = 
    `The following JSON is an array of objects, each containing a line of Asciidoc content and a list of Vale 'rules' that apply to that line.
    The Vale rules are in JSON format, and the 'rules' field is an array of objects, each containing a 'Check', 'Severity', 'Message', 'Description', and 'Line' field.
    The 'pre' field is the original line of Asciidoc content.
    Do not modify any of the existing fields in the JSON.
    Do not modify the 'rules' field. Really don't. I'll notice.
    Add only a 'new' field with the recommended new text for the line (or the unchanged line if no change is recommended).

    ${fence}json
    ${JSON.stringify(collected, null, 2)}
    ${fence}
    
    Return the JSON array with the 'new' field added, and no other changes.
    Return only the JSON, without the backticks to format the JSON code.`

  // assistants file doesn't like .adoc 
  // const contentfile = await openai.files.create(
  //   {
  //     file: fs.createReadStream(`../content-repo/${file}`),
  //     purpose: "assistants",
  //   });

  await openai.beta.threads.messages.create(thread.id, {
    role: "user",
    content: payload,
    // attachments: [
    //   {file_id: contentfile.id, tools: [{ type: "file_search" }]}
    // ]
  });

  // Step 5: Run the assistant on that thread
  const run = await openai.beta.threads.runs.create(thread.id, {
    assistant_id: assistant.id,
  });

  await waitForRunCompletion(thread.id, run.id, openai);
  const returned = await assistantReply(thread.id, openai);
  const updated = JSON.parse(returned);

  console.log('CHECK', updated, diff(collected, updated))

  for (const [equality, subobject] of diff(collected, updated)) {
    assert.equal(equality, '~', 'AI sanity check: expect altered sub-object')
    assert.deepEqual(Object.keys(subobject), ['new__added'], 'AI sanity check: only new field added')
  }

  for (const record of updated) {
    if (record.new !== record.pre) {
      console.log(record)
      console.log(`Line ${record.line} in file ${file} changed from "${record.pre}" to "${record.new}"`);

      console.log(file, record.line, record.new, record.rules)

      await postComment(file, record.line, record.new, record.rules)
    }
  }
}

async function postComment(file, line, newContent, rules) {

  const payload = template({rules, newContent})
  await octokit.request(
    `POST /repos/${repository}/pulls/${pull_request_number}/comments`, 
    {
    body: payload,
    commit_id: head_sha,
    path: file,
    line: parseInt(line),
    start_side: 'RIGHT',
    side: 'RIGHT',
    headers: {
      'X-GitHub-Api-Version': '2022-11-28'
    }
  })
}


async function waitForRunCompletion(threadId, runId, client) {
  while (true) {
    const run = await client.beta.threads.runs.retrieve(threadId, runId);

    if (run.status === 'completed') {
      break;
    }

    if (['failed', 'cancelled', 'expired'].includes(run.status)) {
      throw new Error(`Run failed with status: ${run.status}`);
    }

    // Wait 1 second before checking again
    await new Promise((res) => setTimeout(res, 1000));
  }
}

async function assistantReply(threadId, client) {
  const messages = await client.beta.threads.messages.list(threadId);

  // Get the last message from the assistant
  const assistantMessage = messages.data.find(
    (msg) => msg.role === 'assistant'
  );

  if (!assistantMessage) {
    console.log("No assistant reply found.");
    return;
  }

  // Print the text content of the assistant's reply
  const textParts = assistantMessage.content
    .filter((part) => part.type === 'text')
    .map((part) => part.text?.value || '')
    .join('\n');

  return textParts;
}