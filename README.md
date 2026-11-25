<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset=".github/brand/brainlife-mark-on-dark.svg">
    <img src=".github/brand/brainlife-mark-on-light.svg" alt="brainlife.io" width="140">
  </picture>
</p>

<h1 align="center">Amaretti (legacy)</h1>

<p align="center">
  Lightweight, cross-resource, multi-user task orchestration for ABCD-spec Apps.
</p>

<p align="center">
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-MIT-lightgrey.svg" alt="MIT license"></a>
  <img src="https://img.shields.io/badge/Status-legacy-lightgrey.svg" alt="Status: legacy">
  <a href="https://brainlife.io"><img src="https://img.shields.io/badge/brainlife.io-site-3b9fd0.svg" alt="brainlife.io"></a>
  <a href="https://brainlife.io/docs"><img src="https://img.shields.io/badge/Docs-brainlife.io%2Fdocs-005981.svg" alt="Documentation"></a>
  <a href="https://doi.org/10.1038/s41592-024-02237-2"><img src="https://img.shields.io/badge/DOI-10.1038%2Fs41592--024--02237--2-e57536.svg" alt="Nature Methods paper"></a>
</p>

> [!WARNING]
> **Legacy.** Development of Amaretti moved to [brainlife/amaretti-next](https://github.com/brainlife/amaretti-next) in 2024; this repository has had one commit in 2026 (a LICENSE update). The [brainlife](https://github.com/brainlife/brainlife) development stack still references this repository.

## 🧠 At a glance

| | |
|---|---|
| 🧭 **What** | Runs [ABCD-spec](https://github.com/brainlife/abcd-spec) Apps on remote resources (HPC clusters, clouds) through their own batch schedulers, and tracks instances, tasks and resources |
| 🧱 **Stack** | Node.js · Express · MongoDB · AMQP |
| 📖 **Docs** | [brainlife.github.io/amaretti](https://brainlife.github.io/amaretti/) |
| ➡️ **Use instead** | [amaretti-next](https://github.com/brainlife/amaretti-next) |
| 🕰️ **Last activity** | 2026-08-07 (LICENSE); README updates 2025 |

## 🚀 Running it

```bash
npm install
cp config/index.js.dev config/index.js   # edit
npm start                                   # node api/wf.js
```

Tests: `npm test` (mocha). For a full local stack see [brainlife/brainlife](https://github.com/brainlife/brainlife).

## 🙏 Sponsorship

We gratefully acknowledge the support of the AWS Open Data Program for providing S3 storage resources to brainlife.io.

## 👥 Authors

Soichi Hayashi (author). Contributors: Franco Pestilli, Anibal Heinsfeld, Bradley Caron.

## 📚 Citing

If you use brainlife.io in your work, please cite:

> Hayashi S, Caron BA, Heinsfeld AS, et al. brainlife.io: a decentralized and open-source cloud platform to support neuroscience research. *Nature Methods* 21:809–813 (2024). [doi:10.1038/s41592-024-02237-2](https://doi.org/10.1038/s41592-024-02237-2)

## 💰 Funding

brainlife.io is developed by the Pestilli Lab at The University of Texas at Austin and is publicly funded; acknowledging that support helps keep it running.

<details>
<summary>Grants (verified list, from <a href="https://github.com/brainlife/ezbids/blob/master/CREDITS.md#funding">ezbids CREDITS.md</a>)</summary>

| Funder | Award | Title |
|---|---|---|
| NIH NINDS | [U24NS140384](https://reporter.nih.gov/project-details/U24NS140384) | BRAIN CONNECTS: The Axonal Projectome EXchange (APEX) |
| NIH NIMH | [R01MH126699](https://reporter.nih.gov/project-details/R01MH126699) | Community-driven development of BIDS |
| NIH NIBIB | [R01EB030896](https://reporter.nih.gov/project-details/R01EB030896) | CRCNS US-France: open science and cloud computing of MEEG |
| NIH NIBIB | [R01EB029272](https://reporter.nih.gov/project-details/R01EB029272) | CRCNS US-France: lowering the barrier of entry to network neuroscience |
| NSF | [BCS-1636893](https://www.nsf.gov/awardsearch/showAward?AWD_ID=1636893), [2148729](https://www.nsf.gov/awardsearch/showAward?AWD_ID=2148729) | BD Spokes: Advanced Computational Neuroscience Network |
| NSF | [BCS-1734853](https://www.nsf.gov/awardsearch/showAward?AWD_ID=1734853), [2203524](https://www.nsf.gov/awardsearch/showAward?AWD_ID=2203524) | NCS-FO: Connectome mapping algorithms |
| NSF | [IIS-1912270](https://www.nsf.gov/awardsearch/showAward?AWD_ID=1912270), [2148700](https://www.nsf.gov/awardsearch/showAward?AWD_ID=2148700) | CRCNS US-German: DataLad |
| NSF | [ACI-1916518](https://www.nsf.gov/awardsearch/showAward?AWD_ID=1916518) | BD Hubs: Midwest Big Data Hub |
| Wellcome Trust | [226486](https://grantnav.threesixtygiving.org/grant/360G-Wellcome-226486_Z_22_Z) | Developing an international governance framework to advance global brain and mental health data equity and innovation |

</details>

## 🤝 Contributing

Issues and pull requests are welcome in this repository. For help using brainlife.io, see the [documentation](https://brainlife.io/docs).

## ⚖️ License

[MIT](LICENSE).

<p align="center"><sub>brainlife.io · Brain data across scales. One place to analyze, share and publish it. · The University of Texas at Austin</sub></p>
