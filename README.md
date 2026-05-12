# UC Berkeley Solar Energy Testbed Webpage

This folder contains a single-page static website for the solar energy testbed project.

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
