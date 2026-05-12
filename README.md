# UC Berkeley Solar Energy Testbed Webpage

This folder contains a single-page static website for the solar energy testbed project.

# Solar Energy Testbed

This repository hosts the public webpage for the UC Berkeley Solar Energy Testbed project.

The testbed focuses on operation monitoring of a solar energy system with an inverter under a variety of environmental impacts, including wind and other extreme conditions.

## Project Team

- Prof. Khalid M. Mosalam, UC Berkeley
- Omar Shabana, PhD Student, UC Berkeley
- Naiqi Guo, MS Student, UC Berkeley
- Jiawei Chen, Postdoctoral Researcher, UC Berkeley

## Website

The project webpage is published using GitHub Pages:

https://k-mosalam.github.io/solar-energy-testbed/

## Repository Structure

```text
.
├── index.html
├── README.md
└── assets/


## Files

```text
solar-testbed-webpage/
├── index.html
├── README.md
└── assets/
    └── solar-testbed-under-construction.jpeg
```

## How to publish on GitHub Pages

1. Create a new GitHub repository, for example `solar-energy-testbed`.
2. Upload `index.html`, `README.md`, and the `assets` folder to the repository root.
3. Go to **Settings → Pages**.
4. Under **Build and deployment**, choose:
   - Source: `Deploy from a branch`
   - Branch: `main`
   - Folder: `/root`
5. Save and wait for GitHub to publish the site.

The published URL will look like:

```text
https://k-mosalam.github.io/solar-energy-testbed/
```

## Suggested next improvements

- Add UC Berkeley, PEER, STAIRlab, CalNEXT, and NextPower logos if approved.
- Replace the placeholder construction photo with a small gallery once the testbed is assembled outdoors.
- Add a simple figure showing the electrical layout: PV modules → string inverter → battery/storage → data logger.
- Add a simple figure showing the monitoring loop: environmental exposure → electrical response → LiDAR scan → digital twin update.
- Add links to related papers, proposals, and demonstrations when they are ready for public sharing.
