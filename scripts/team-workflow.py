#!/usr/bin/env python3
"""Repository entrypoint; implementation travels with the shared skill."""
import runpy
from pathlib import Path
runpy.run_path(str(Path(__file__).resolve().parents[1] / '.agents/skills/gitlab-collaboration/scripts/team_workflow.py'), run_name='__main__')
