# Ember Haven

**Hold the light. Survive the night.**

Ember Haven is an original survival strategy game for Android. The town has been overrun. You command a handful of survivors from an old fire station. By day you send squads out to scout and scavenge the town, rescue the people hiding in it, and claim buildings to grow your haven. By night you fortify, light the dark and hold the line while the infected horde marches on you. Survive until the convoy arrives on **Day 13**.

The art direction is dark and grounded: muted natural colours, soft shadows, weathered roads and roofs, overgrown lots and a film-grain grade, with warm firelight against cold nights.

The game is built with TypeScript and HTML5 Canvas and packaged as a native Android app with [Capacitor](https://capacitorjs.com/). All art, icons and sound are generated in code, so there are no third-party assets.

## Install on your phone

1. On your Android phone, open this repository on GitHub and download [`releases/EmberHaven-0.4.0-debug.apk`](releases/EmberHaven-0.4.0-debug.apk). Tap **Download raw file**.
2. Open the downloaded file. If Android asks, allow your browser or file manager to **install unknown apps**.
3. Tap **Install** and launch **Ember Haven**. The game runs in landscape.

> This is a debug-signed prototype build, meant for testing and sideloading. A Play Store release needs a release keystore (see [Release build](#release-build)).

Every push to the repository also builds a fresh APK through GitHub Actions. You can download it from the **Actions** tab, under the run's **Artifacts**.

## How to play

| | |
|---|---|
| **Command squads** | Tap a squad card (Alpha, Bravo, Charlie) to select it. Tap the ground to move it, or tap a building for orders. Tap the selected card again to assign or send home members. |
| **Scout and scavenge** | Scouting reveals what's inside a building: supplies, infected and survivors. Scavenging brings everything back to your stockpile. Infected hiding inside burst out when you arrive. |
| **Grow the haven** | Claim cleared buildings next to your haven for more beds. Rescued survivors walk to the haven and stand guard. |
| **Fortify and build** | Barricade haven buildings (planks, then sandbags, then steel). Placed structures start as construction sites that your haven guards build when no infected are close (engineers work faster). Choose from watchtowers, fire barrels, gardens, workshops, infirmary tents, spike traps and palisade walls. |
| **Walls and traps** | Draw a palisade wall with two taps (up to 150 m). Walls stop the infected, who have to break through, while your own people slip through the gaps. Spike traps wound anything that walks over them and wear out with use. Tap any structure to check it, cancel it, or take it down for a partial refund. Damaged defences are repaired with materials at dawn. |
| **Demolish and scrap** | Squads can tear down any building except your HQ for materials, and bigger and sturdier buildings give more. The crew works around the outside, the noise draws the infected, and progress is kept if they leave, so you can come back and finish. Supplies and survivors inside are taken out first, and the lot becomes buildable rubble. Squads can also strip abandoned cars, wrecks and spare vehicles for materials and fuel. |
| **Nights** | At 20:00 a horde marches on the haven from one or more directions. It gets bigger every night. Light the dark so your guards can see, and bring your squads home. |
| **Roles** | Every survivor has a role. Soldiers hit harder and take more punishment. Scouts move faster, see further and scout quickly. Medics heal anyone near them. Engineers at the haven make building and barricades 20% cheaper and improve repairs and workshops. Scavengers make their squad scavenge faster and find extra supplies. Tap a squad card to choose exactly who goes out. |
| **Vehicles** | Abandoned cars, a police cruiser and a delivery van are scattered around town. Repair one with materials and take it, and that squad drives any trip longer than a couple of blocks. Driving burns fuel (found at gas stations, farms and depots), makes noise, and lets you run the infected down, though that damages the vehicle. |
| **Weather** | Each day brings clear skies, cloud, rain or fog, and it can change at midday. Rain muffles gunfire but cuts visibility; fog lets the infected get close before you see them. |
| **Upkeep** | Each survivor eats one food at dawn. Medicine treats the badly wounded at dawn, and spare materials repair damaged walls. Gunfire is loud and attracts the infected; melee is quiet. |

**Settings** (title screen or pause menu): music, sound effects, vibration, graphics quality (High, Balanced, or Battery saver for slower phones) and brightness.

**Controls:** drag to pan, pinch (or use the mouse wheel) to zoom, and tap to select or command. The buttons at the top right pause the game or speed it up to 2× or 3×. The Android back button opens the pause menu.

## Develop

Requirements: Node 20+ (22 recommended). Building the APK also needs JDK 21 and the Android SDK (platform 36, build-tools 35).

```bash
npm install
npm run dev          # play in a browser at http://localhost:5173
npm run typecheck
npm run build        # web build -> dist/
npm run build:single # one self-contained HTML file -> dist-single/index.html
```

### Android

```bash
npm run android:sync           # build the web app and copy it into android/
cd android && ./gradlew assembleDebug
# APK: android/app/build/outputs/apk/debug/app-debug.apk
```

You can also open the `android/` folder in Android Studio and press Run.

### Release build

Create a keystore and sign the release variant:

```bash
keytool -genkey -v -keystore ember-haven.jks -alias ember -keyalg RSA -keysize 2048 -validity 10000
cd android && ./gradlew assembleRelease   # or bundleRelease for the Play Store (.aab)
```

Then configure `signingConfigs` in `android/app/build.gradle`. Keep the keystore out of git.

## Project layout

```
src/
  main.ts               game loop, app controller, input -> commands
  core/                 seeded RNG and noise, math helpers
  world/
    mapgen.ts           procedural town generator (fixed seed = pre-generated map)
    nav.ts              navigation grid, A* pathfinding, horde flow field
    types.ts            map data model (roads, building footprints, areas, props)
  game/
    state.ts            save-able game state, tunables and balance
    sim.ts              simulation: squads, infected, combat, nights, economy
  render/
    mapRenderer.ts      cached tile renderer for the static town
    worldRenderer.ts    units, overlays, lighting, fog of war, effects
    camera.ts, textures.ts
  ui/                   HUD, building cards, build menu, title and end screens, icons
  audio/sfx.ts          procedural WebAudio sound effects (incl. rain, engines)
  audio/music.ts        generative ambient score that reacts to night and danger
android/                Capacitor Android project (landscape, immersive full-screen)
releases/               prebuilt APKs
```

## Map

For now the town is generated from a fixed seed (`SEED` in `src/main.ts`), so every game uses the same pre-generated map. The generator outputs plain map data (road segments, building footprints with types, land-use areas and props), which is the same shape of data that OpenStreetMap provides. A real-world map importer can replace `generateMap()` later without touching the rest of the game.

## Roadmap ideas

- Real-world locations from OpenStreetMap data
- Survivor traits and skills that improve with experience
- Rival survivor groups and trading
- Seasons and more structure types (walls, traps, generators)
- Fuel-powered generators and electric lights for the haven

## License

All code and generated assets in this repository are original work for Ember Haven.
