/* ======================================================
   Static Scene Background – Main Module Script (PixiJS)
   ====================================================== */

const MODULE_ID = "static-scene-background";

let bgContainer = null;
let bgSprite = null;
let bgMask = null;
let _customSrc = null; // manual API override image source
let currentLoadId = 0;

/**
 * Clean up existing Pixi background resources
 */
function cleanupBackground() {
  if (canvas.app?.renderer?.background) {
    canvas.app.renderer.background.alpha = 1;
  }

  if (canvas.app && canvas.app.ticker && updateBgPosition) {
    canvas.app.ticker.remove(updateBgPosition);
  }

  if (bgSprite) {
    bgSprite.destroy({ children: true, texture: false, baseTexture: false });
    bgSprite = null;
  }

  if (bgMask) {
    if (bgMask.parent) bgMask.parent.removeChild(bgMask);
    bgMask.destroy();
    bgMask = null;
  }

  if (bgContainer) {
    if (bgContainer.parent) bgContainer.parent.removeChild(bgContainer);
    bgContainer.destroy();
    bgContainer = null;
  }
}

/**
 * Load and blur an image offline using HTML5 2D Canvas.
 * This is extremely performant (only runs once on load) and avoids WebGL stencil mask conflicts.
 */
function blurImageOffline(src, blurRadius) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => {
      const canvas2d = document.createElement("canvas");
      
      const maxDim = 1024;
      let w = img.width;
      let h = img.height;
      if (w > maxDim || h > maxDim) {
        if (w > h) {
          h = Math.round((h * maxDim) / w);
          w = maxDim;
        } else {
          w = Math.round((w * maxDim) / h);
          h = maxDim;
        }
      }
      
      canvas2d.width = w;
      canvas2d.height = h;
      
      const ctx = canvas2d.getContext("2d");
      if (!ctx) {
        reject(new Error("Failed to get 2D context"));
        return;
      }
      
      if (typeof ctx.filter !== "string") {
        reject(new Error("Canvas 2D context filter is not supported in this browser."));
        return;
      }
      
      ctx.filter = `blur(${blurRadius}px)`;
      
      // Draw slightly larger to avoid transparent edge artifact
      const pad = blurRadius * 2;
      ctx.drawImage(img, -pad, -pad, w + pad * 2, h + pad * 2);
      
      resolve(canvas2d);
    };
    img.onerror = (err) => reject(err);
    img.src = src;
  });
}

/**
 * The ticker update function to keep the background static relative to viewport
 * and draw the mask with a hole covering the scene bounds.
 */
function updateBgPosition() {
  if (!bgSprite || bgSprite.destroyed || !canvas.stage) return;

  // Use toLocal to calculate bounds independent of stage pivot/scale/pan offset
  const topLeft = canvas.stage.toLocal(new PIXI.Point(0, 0));
  const bottomRight = canvas.stage.toLocal(new PIXI.Point(window.innerWidth, window.innerHeight));

  const viewportWidth = bottomRight.x - topLeft.x;
  const viewportHeight = bottomRight.y - topLeft.y;

  // Scale bgSprite using "cover" logic to preserve aspect ratio
  const textureWidth = bgSprite.texture?.width || 0;
  const textureHeight = bgSprite.texture?.height || 0;

  if (textureWidth > 0 && textureHeight > 0) {
    const scaleX = viewportWidth / textureWidth;
    const scaleY = viewportHeight / textureHeight;
    const scale = Math.max(scaleX, scaleY); // Choose larger scale to cover viewport

    bgSprite.scale.set(scale, scale);

    // Center the sprite relative to the viewport
    const spriteWidthInStage = textureWidth * scale;
    const spriteHeightInStage = textureHeight * scale;
    const offsetX = (viewportWidth - spriteWidthInStage) / 2;
    const offsetY = (viewportHeight - spriteHeightInStage) / 2;

    bgSprite.position.set(topLeft.x + offsetX, topLeft.y + offsetY);
  } else {
    // Fallback if texture properties are not available
    bgSprite.position.set(topLeft.x, topLeft.y);
    bgSprite.width = viewportWidth;
    bgSprite.height = viewportHeight;
  }

  // 2. Re-draw the mask to only show outer area
  if (bgMask && !bgMask.destroyed) {
    bgMask.clear();
    bgMask.beginFill(0xffffff);

    // Viewport bounds in stage space
    const vx = topLeft.x;
    const vy = topLeft.y;
    const vw = bottomRight.x - topLeft.x;
    const vh = bottomRight.y - topLeft.y;
    bgMask.drawRect(vx, vy, vw, vh);

    // Scene hole
    if (canvas.dimensions) {
      bgMask.beginHole();
      const r = (bgSprite.useTransparent && canvas.dimensions.sceneRect)
        ? canvas.dimensions.sceneRect
        : canvas.dimensions.rect;
      if (r) {
        bgMask.drawRect(r.x, r.y, r.width, r.height);
      }
      bgMask.endHole();
    }
    bgMask.endFill();
  }
}

/**
 * Apply the blurred background image to the canvas
 * @param {string|null} imageSrc  URL/path of the image
 * @param {number}       blur     Blur amount
 */
async function applyPixiBackground(imageSrc, blur, useTransparent) {
  const loadId = ++currentLoadId;
  cleanupBackground();

  if (!imageSrc || !canvas.stage) return;

  const renderedGroup = canvas.stage.children.find(c => c.constructor.name === "RenderedCanvasGroup");
  if (!renderedGroup) return;

  try {
    let texture;
    let fallbackToFilter = false;

    if (blur > 0) {
      try {
        const blurredCanvas = await blurImageOffline(imageSrc, blur);
        if (loadId !== currentLoadId) return;
        texture = PIXI.Texture.from(blurredCanvas);
      } catch (err) {
        if (loadId !== currentLoadId) return;
        console.warn("Static Scene Background | Offline blur failed, falling back to WebGL filter:", err);
        fallbackToFilter = true;
        texture = PIXI.Texture.from(imageSrc);
        if (!texture.baseTexture.valid) {
          await new Promise((resolve) => {
            texture.baseTexture.once('loaded', resolve);
            setTimeout(resolve, 2000);
          });
          if (loadId !== currentLoadId) return;
        }
      }
    } else {
      texture = PIXI.Texture.from(imageSrc);
      if (!texture.baseTexture.valid) {
        await new Promise((resolve) => {
          texture.baseTexture.once('loaded', resolve);
          setTimeout(resolve, 2000);
        });
        if (loadId !== currentLoadId) return;
      }
    }

    // Double check we haven't cleaned up during async load
    if (!canvas.stage) return;

    // Make sure we clean up any older backgrounds created by concurrent requests
    cleanupBackground();

    bgContainer = new PIXI.Container();
    bgContainer.name = "static-scene-bg-container";

    bgSprite = new PIXI.Sprite(texture);
    bgSprite.name = "static-scene-bg-pixi";
    bgSprite.imageSrc = imageSrc; // Store original source for verification/debugging
    bgSprite.useTransparent = useTransparent; // Cache the transparency setting

    // Set fallback filter if offline blur failed
    if (fallbackToFilter && blur > 0 && PIXI.filters) {
      // Find BlurFilter by checking constructor name or minified equivalent
      const BlurFilterClass = PIXI.filters.BlurFilter || Object.values(PIXI.filters).find(f => {
        try {
          const inst = new f();
          return typeof inst.blur === "number";
        } catch(e) { return false; }
      });
      if (BlurFilterClass) {
        const blurFilter = new BlurFilterClass();
        blurFilter.blur = blur;
        bgSprite.filters = [blurFilter];
      }
    }

    bgContainer.addChild(bgSprite);
    renderedGroup.addChildAt(bgContainer, 1);

    // Create mask
    bgMask = new PIXI.Graphics();
    bgMask.name = "static-scene-bg-mask";
    renderedGroup.addChild(bgMask);
    bgContainer.mask = bgMask;

    // Run initial update and register ticker
    updateBgPosition();
    canvas.app.ticker.add(updateBgPosition);
  } catch (error) {
    console.error("Static Scene Background | Failed to load background texture:", error);
  }
}

/**
 * Refresh background from settings and scene state
 */
function refreshFromScene() {
  const enabled = game.settings.get(MODULE_ID, "enabled");
  if (!enabled) {
    cleanupBackground();
    return;
  }

  const customBg = canvas.scene?.getFlag(MODULE_ID, "customBackground");
  const globalBg = game.settings.get(MODULE_ID, "globalBackground");
  const src = _customSrc ?? (customBg || null) ?? (globalBg || null) ?? canvas.scene?.background?.src ?? null;

  const sceneBlur = canvas.scene?.getFlag(MODULE_ID, "sceneBlur");
  const blur = (sceneBlur !== undefined && sceneBlur !== null) ? sceneBlur : game.settings.get(MODULE_ID, "blurAmount");

  const sceneTransparent = canvas.scene?.getFlag(MODULE_ID, "transparentBg");
  const useTransparent = (sceneTransparent !== undefined && sceneTransparent !== null && sceneTransparent !== "")
    ? (sceneTransparent === "true" || sceneTransparent === true)
    : game.settings.get(MODULE_ID, "transparentBg");

  if (canvas.app?.renderer?.background) {
    canvas.app.renderer.background.alpha = useTransparent ? 0 : 1;
  }

  applyPixiBackground(src, blur, useTransparent);
}

/* ---------- API methods ---------- */

function setBackgroundAPI(imageUrl) {
  _customSrc = imageUrl;
  refreshFromScene();
}

function resetBackgroundAPI() {
  _customSrc = null;
  refreshFromScene();
}

function setBlurAPI(amount) {
  let val = Number(amount);
  if (isNaN(val)) val = 20;
  const clamped = Math.min(50, Math.max(0, val));
  game.settings.set(MODULE_ID, "blurAmount", clamped);
}

/* ---------- Hooks ---------- */

Hooks.once("init", () => {
  // --- Settings ---
  game.settings.register(MODULE_ID, "enabled", {
    name: "Enable Static Background",
    hint: "Show a blurred copy of the scene background behind the canvas.",
    scope: "client",
    config: true,
    type: Boolean,
    default: true,
    onChange: () => {
      _customSrc = null;
      refreshFromScene();
    },
  });

  game.settings.register(MODULE_ID, "blurAmount", {
    name: "Blur Intensity",
    hint: "Amount of gaussian blur applied to the background (pixels).",
    scope: "client",
    config: true,
    type: Number,
    default: 20,
    range: {
      min: 0,
      max: 50,
      step: 1,
    },
    onChange: () => {
      refreshFromScene();
    },
  });

  game.settings.register(MODULE_ID, "globalBackground", {
    name: "Global Background Override",
    hint: "Specify a default image to blur for every scene instead of using the scene's map image. Leave blank to use each scene's individual map image.",
    scope: "world",
    config: true,
    type: String,
    default: "",
    filePicker: "image",
    onChange: () => {
      refreshFromScene();
    },
  });

  game.settings.register(MODULE_ID, "transparentBg", {
    name: "Transparent Background Color",
    hint: "Extend the blurred background into the scene's padding/margin area, replacing the solid background color.",
    scope: "client",
    config: true,
    type: Boolean,
    default: false,
    onChange: () => {
      refreshFromScene();
    },
  });
});

Hooks.once("ready", () => {
  // Expose public API
  const moduleData = game.modules.get(MODULE_ID);
  if (moduleData) {
    moduleData.api = {
      setBackground: setBackgroundAPI,
      resetBackground: resetBackgroundAPI,
      setBlur: setBlurAPI,
    };
  }
});

Hooks.on("canvasReady", () => {
  _customSrc = null;
  refreshFromScene();
});

Hooks.on("updateScene", (scene, changes) => {
  if (scene.id !== canvas.scene?.id) return;

  if ("background" in changes || "backgroundColor" in changes || ("flags" in changes && MODULE_ID in changes.flags)) {
    _customSrc = null;
    refreshFromScene();
  }
});

Hooks.on("renderSceneConfig", (app, html, data) => {
  // In Foundry v13 (ApplicationV2), html is a raw HTMLElement, not jQuery.
  // app.element is the definitive reference to the application root.
  const element = app.element ?? html;

  // Try multiple selectors to find the Background Image form-group
  let anchorGroup = null;

  // Strategy 1: direct input name selectors (file-picker custom element in v13)
  const bgInput = element.querySelector('file-picker[name="background.src"]')
    || element.querySelector('input[name="background.src"]');
  if (bgInput) {
    anchorGroup = bgInput.closest('.form-group');
  }

  // Strategy 2: find by label text
  if (!anchorGroup) {
    for (const label of element.querySelectorAll('label')) {
      if (/background\s*image/i.test(label.textContent)) {
        anchorGroup = label.closest('.form-group');
        break;
      }
    }
  }

  // Strategy 3: fall back to "Foreground Image" and insert before it
  let insertBefore = false;
  if (!anchorGroup) {
    for (const label of element.querySelectorAll('label')) {
      if (/foreground\s*image/i.test(label.textContent)) {
        anchorGroup = label.closest('.form-group');
        insertBefore = true;
        break;
      }
    }
  }

  if (!anchorGroup) return;

  // Skip the hint/notes paragraph that follows the anchor group (if any)
  let insertAfterEl = anchorGroup;
  if (!insertBefore) {
    let next = anchorGroup.nextElementSibling;
    if (next && (next.tagName === 'P' || next.classList.contains('notes') || next.classList.contains('hint'))) {
      insertAfterEl = next;
    }
  }

  const doc = app.document || app.object;
  const bgValue = doc?.getFlag(MODULE_ID, "customBackground") || "";
  const blurValue = doc?.getFlag(MODULE_ID, "sceneBlur");
  const hasSceneBlur = blurValue !== undefined && blurValue !== null;
  const globalBlur = game.settings.get(MODULE_ID, "blurAmount");
  const displayBlur = hasSceneBlur ? blurValue : globalBlur;

  const transparentValue = doc?.getFlag(MODULE_ID, "transparentBg");
  const isInherit = (transparentValue === undefined || transparentValue === null || transparentValue === "") ? 'selected' : '';
  const isTrue = (transparentValue === "true" || transparentValue === true) ? 'selected' : '';
  const isFalse = (transparentValue === "false" || transparentValue === false) ? 'selected' : '';

  // --- Blurred Background Image picker ---
  const bgGroup = document.createElement("div");
  bgGroup.className = "form-group";
  bgGroup.innerHTML = `
    <label>Blurred Background Image</label>
    <div class="form-fields">
      <input type="text" name="flags.${MODULE_ID}.customBackground" value="${bgValue}" placeholder="Same as Background Image" />
      <button type="button" class="file-picker" data-type="imagevideo" data-target="flags.${MODULE_ID}.customBackground">
        <i class="fas fa-file-import"></i>
      </button>
    </div>
    <p class="hint">Optional separate image used for the blurred background outside the map bounds. Leave blank to blur the scene's Background Image.</p>
  `;

  // --- Scene Blur Amount slider ---
  const blurGroup = document.createElement("div");
  blurGroup.className = "form-group";
  blurGroup.innerHTML = `
    <label>Scene Blur Amount</label>
    <div class="form-fields">
      <input type="range" name="flags.${MODULE_ID}.sceneBlur" min="0" max="50" step="1"
        value="${displayBlur}" ${!hasSceneBlur ? 'data-default="true"' : ''} />
      <span class="range-value">${displayBlur}</span>
    </div>
    <p class="hint">Blur intensity for this scene (0–50 px). Defaults to the global setting (${globalBlur}) if unchanged.</p>
  `;

  // --- Transparent Background Color select ---
  const transparentGroup = document.createElement("div");
  transparentGroup.className = "form-group";
  transparentGroup.innerHTML = `
    <label>Transparent Background Color</label>
    <div class="form-fields">
      <select name="flags.${MODULE_ID}.transparentBg">
        <option value="" ${isInherit}>Default (Global Setting)</option>
        <option value="true" ${isTrue}>Transparent</option>
        <option value="false" ${isFalse}>Opaque</option>
      </select>
    </div>
    <p class="hint">If set to Transparent, the blurred background will extend into the scene's padding/margin area, replacing the solid background color.</p>
  `;

  if (insertBefore) {
    anchorGroup.before(bgGroup, blurGroup, transparentGroup);
  } else {
    insertAfterEl.after(transparentGroup);
    insertAfterEl.after(blurGroup);
    insertAfterEl.after(bgGroup);
  }

  // Wire up the file picker button
  const filePickerBtn = bgGroup.querySelector('.file-picker');
  filePickerBtn.addEventListener('click', (ev) => {
    const fp = new FilePicker({
      type: "imagevideo",
      field: bgGroup.querySelector('input[type="text"]'),
      current: bgValue,
      button: filePickerBtn
    });
    fp.browse();
  });

  // Wire up the range slider to show its current value
  const rangeInput = blurGroup.querySelector('input[type="range"]');
  const rangeDisplay = blurGroup.querySelector('.range-value');
  rangeInput.addEventListener('input', (ev) => {
    rangeDisplay.textContent = ev.target.value;
    // Once the user touches the slider, it's no longer "default"
    delete ev.target.dataset.default;
  });
});
