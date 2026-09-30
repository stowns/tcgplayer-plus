# AGENTS.md


## Architecture
- Browser extension for Firefox and Chrome (MV3), one codebase, built per browser into dist/firefox and dist/chrome

## Testing
- Before starting a task, check if affected source code has adequate unit test coverage
- If coverage is lacking, add unit tests first to detect regressions during development
- All newly added source code must include corresponding unit tests

## Licensing
- This project is licensed under GPLv3
- When including 3rd-party software, prefer open source libraries with permissive licenses: MIT, CC0, Apache 2.0, or BSD 3-Clause
