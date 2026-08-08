This repository is for building an offshore blogging / weather retrieval system (`SPEC.md`).

## Work documents

Technical work is planned with work documents (in Markdown) that are managed using `rngit` tool and repository in `rns://3ea5aad068a337670f5bb8073226adb4/public/dacar`. The appropriate [pi skill extension](https://github.com/bergie/pi-rngit-work-document-skill) should be available.

When planning new work, there should always be a corresponding work document created explaining the idea. When implementing, the appropriate work document should be kept up-to-date by posting updates to it. Agent may _propose_ work documents, not _create_ them.

## Boundaries

- ✅ **Always**: write at least smoketests for any new functionality
- ✅ **Always**: fix formatting with `npm run format` (in Android/Termux `biome check --use-editorconfig=true --write packages/*/src packages/*/test examples`) after any changes to source files or tests
- ✅ **Always**: Use `git mv` instead of `mv' for renaming files
- ⚠️ **Ask first**: adding dependencies
- ⚠️ **Ask first**: modify CI config
- 🚫 **Never**: AI agents may not make commits on their own, instead notify user that there are uncommitted changes to review
