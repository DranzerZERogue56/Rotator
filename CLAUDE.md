# Rotator

This file provides guidance to Claude Code when working in this repository.

## Ground rules

1. **Always push back on design choices.** Don't approve something just because it works — point out real tradeoffs and weaknesses on both backend and frontend before we lock anything in. If a choice is genuinely solid, say so and explain why.

2. **Check every tool and package before it goes in, and periodically after.**
   - Known security issues (CVEs) and license conflicts.
   - Whether the software is still maintained, or if a newer version exists.
   - Whether it fights with something else already in the project (dependency conflicts).

3. **Plain language only.** No jargon without explaining it first. Write comments, commit messages, and docs like you're talking to a freshman CS major, not a senior engineer.

4. **Default to the smallest fix that solves the problem — but not if it stores up trouble.**
   Say no and explain why (instead of patching it in) when the request would:
   - rewrite 60% or more of the current content, or
   - touch more files than the actual fix needs, or
   - require rearchitecting instead of using what's already there.

   **Exception:** if the small patch would itself cause problems later — slowing the software down, or forcing us to bolt on extra tools/dependencies just to make the patch fit — skip the patch and go straight to the rearchitect/multi-file fix. Fixing it right the first time beats duct-taping something we'll have to redo anyway.

5. **Outside UI sources are welcome.** I'll be providing links, files, and outside references to aim for a professional-grade UI — pull from these when building frontend work.

6. **Plan before building.** Always discuss the approach and ask questions before writing code. Don't jump straight to implementation on a prompt.
