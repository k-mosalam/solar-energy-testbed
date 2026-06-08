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
├── docs/
│   ├── index.html
│   ├── energy.html
│   ├── gallery.html
│   ├── styles.css
│   ├── assets/
│   └── goodwe-exports/
├── scripts/
│   └── get_data.py
├── requirements-python.txt
└── README.md
```

## How to publish on GitHub Pages

1. Create a new GitHub repository, for example `solar-energy-testbed`.
2. Push the repository contents to GitHub with the site files inside the `docs/` folder.
3. Go to **Settings → Pages**.
4. Under **Build and deployment**, choose:
   - Source: `Deploy from a branch`
   - Branch: `main`
   - Folder: `/docs`
5. Save and wait for GitHub to publish the site.

The published URL will look like:

```text
https://k-mosalam.github.io/solar-energy-testbed/
```

## Data Script

The repository uses a Python export script with the same output folder and date-selection logic:

```bash
python scripts/get_data.py
```

Common ways to run it:

```bash
# Update the latest 3 available dates (default mode)
python scripts/get_data.py

# Download one specific date
python scripts/get_data.py --date 2026-06-07

# Download every available date from a starting date through the current remote latest date
python scripts/get_data.py --since 2026-06-01

# Refresh a custom number of most recent days
python scripts/get_data.py --refresh-days 7
```

To install the Python dependencies:

```bash
pip install -r requirements-python.txt
python -m playwright install
```

## Suggested next improvements

- Add UC Berkeley, PEER, STAIRlab, CalNEXT, and NextPower logos if approved.
- Replace the placeholder construction photo with a small gallery once the testbed is assembled outdoors.
- Add a simple figure showing the electrical layout: PV modules → string inverter → battery/storage → data logger.
- Add a simple figure showing the monitoring loop: environmental exposure → electrical response → LiDAR scan → digital twin update.
- Add links to related papers, proposals, and demonstrations when they are ready for public sharing.

## Local setup note

- To install the Python dependencies locally, run:

```bash
pip install -r requirements-python.txt
python -m playwright install
```

- For GitHub Pages publishing, the site files are served from the `docs/` folder.
