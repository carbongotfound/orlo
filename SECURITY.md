# Security Policy

## Reporting a vulnerability

Please **don't** open a public issue. Report it privately instead: go to the **Security** tab of this repository and choose **Report a vulnerability**.

Include what you found, how to reproduce it, and what an attacker could do with it. You'll get a reply within a week, and we'll work with you on a fix and a release before anything is disclosed.

## Scope

These are in scope:

- running arbitrary code or commands through Orlo without the user delegating a task;
- Orlo exposing, logging or sending credentials, tokens or API keys anywhere;
- agent runs escaping their stop and time limits, or running after Orlo closes;
- reading or writing files outside the data and work folders, beyond what the user delegated.

Out of scope: what an agent does inside a task you delegated to it. Agents run commands with your permissions by design, as explained in the README.

## Supported versions

Only the latest release gets security fixes.
