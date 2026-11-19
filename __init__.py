"""Expose the optional reporting instructions to Hermes Agent."""

from pathlib import Path


def register(ctx):
    skill = Path(__file__).parent / "skills" / "session-progress-counter" / "SKILL.md"
    ctx.register_skill("session-progress-counter", skill)
