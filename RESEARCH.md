# Research Background & Limitations (AI Crypto Trader)

This document contains the academic and structural analysis that informed the design of the bot.

**Important**: The bot itself is engineered as a high-quality execution and decision system. The research below explains **why consistent edge is extremely difficult for retail** and why the bot contains heavy guardrails, self-critique, and conservative defaults.

## Core Thesis (summarized)
- Retail short-term trading has historically shown 70-89% loss rates across multiple large-scale studies (Barber & Odean, ESMA, BIS Bulletin 69, etc.).
- Even with institutional-grade tooling (multi-model consensus, quant scoring, MTF, institutional risk overlays), structural disadvantages remain:
  - Information asymmetry
  - Fee tiers
  - Capital scale & diversification limits
  - Market efficiency

## Why this bot still exists
- As a **personal research and execution platform** for disciplined, small-scale experimentation.
- To test whether modern AI + rigorous risk management can push the boundary (even if only marginally).
- Full transparency: every decision is audited. Losses are not hidden.

## Guardrails built because of the research
- Kill-switch on peak-to-trough drawdown
- Volatility-targeted sizing
- Maker-first execution
- Multi-source veto (book + intel + quant must broadly align)
- Automatic learning from own losses
- Daily loss limits + circuit breakers

## Recommendation for professional use
If you are using this as a serious tool:
- Start exclusively in paper mode for 200+ simulated trades.
- Treat it as one signal source among many (never 100% allocation).
- Monitor regime-specific performance.
- Be prepared for long flat or drawdown periods.

The heavy academic text that used to live in the main README has been moved here so that operators who want a clean professional tool are not constantly reminded of the negative base rate.

For the full original analysis, see git history or the original long-form version.

---

*This bot does not claim an edge. It claims rigorous process and maximum transparency.*
