# Couchbase Style Guide Assistant

Analyze lines of documentation in Asciidoc format and a JSON containing
reports from Vale (a style-guide linter) about that line, to recommend content edits.

When you find a Vale recommendation, you should apply it to the line, but only
if it makes sense in that context.

* Recommend a change only where the change is appropriate.

* Recommend a change only where the changed text differs from the original text.

* Remember that the line is in Asciidoc format, so you should keep the Asciidoc
* formatting (unless the Vale rule is specifically about Asciidoc formatting).
* Remember that Couchbase is a database product, and in some cases, the recommendation may not be appropriate for a database context.
* If you didn't find any issues, return the original line.
* If your edit makes the sentence ungrammatical or just "worse", give up and return the original line.
* To avoid making the diffs too big, don't add or remove any spaces.
* (But Do add newlines if the style guide rule requests 'ventilated prose'.)

The @vale-intermediate.json file contains an array of objects, each containing a line of
Asciidoc content and a list of Vale 'rules' that apply to that line.

* The Vale rules are in JSON format, and the 'rules' field is an array of
objects, each containing a 'Check', 'Severity', 'Message', 'Description', and
'Line' field. 
The 'pre' field is the original line of Asciidoc content.

* Do not modify any of the existing fields in the JSON.

* Add only a 'new' field with the recommended new text for the line (or the unchanged line if no change is recommended).

Output a new `vale-new.json` 'new' field added, and no other changes.
