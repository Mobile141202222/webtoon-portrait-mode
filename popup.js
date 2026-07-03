/**
 * Webtoon Portrait Mode — Popup Logic
 * Handles saving/loading settings and communicating with the content script.
 */

(function () {
  "use strict";

  const DEFAULT_SETTINGS = {
    fitWidth: true,
    zenMode: false,
    widthPercent: 100,
    bgColor: "#000000",
    hideMouse: false,
    autoNext: true,
  };
  const ALLOWED_BG_COLORS = new Set([
    "#000000",
    "#1a1a2e",
    "#2d2d2d",
    "original",
  ]);

  function normalizeSettings(settings) {
    const width = Number(settings.widthPercent);

    return {
      fitWidth:
        typeof settings.fitWidth === "boolean"
          ? settings.fitWidth
          : DEFAULT_SETTINGS.fitWidth,
      zenMode:
        typeof settings.zenMode === "boolean"
          ? settings.zenMode
          : DEFAULT_SETTINGS.zenMode,
      widthPercent: Number.isFinite(width)
        ? Math.min(Math.max(Math.round(width), 40), 100)
        : DEFAULT_SETTINGS.widthPercent,
      bgColor: ALLOWED_BG_COLORS.has(settings.bgColor)
        ? settings.bgColor
        : DEFAULT_SETTINGS.bgColor,
      hideMouse:
        typeof settings.hideMouse === "boolean"
          ? settings.hideMouse
          : DEFAULT_SETTINGS.hideMouse,
      autoNext:
        typeof settings.autoNext === "boolean"
          ? settings.autoNext
          : DEFAULT_SETTINGS.autoNext,
    };
  }

  // DOM elements
  const fitWidthToggle = document.getElementById("fitWidth");
  const zenModeToggle = document.getElementById("zenMode");
  const hideMouseToggle = document.getElementById("hideMouse");
  const autoNextToggle = document.getElementById("autoNext");
  const widthSlider = document.getElementById("widthPercent");
  const widthValue = document.getElementById("widthValue");
  const sliderRow = document.getElementById("sliderRow");
  const colorButtons = document.querySelectorAll(".color-btn");
  const resetBtn = document.getElementById("resetBtn");
  const statusBadge = document.getElementById("statusBadge");

  /**
   * Save current settings to chrome.storage.local
   */
  function saveSettings() {
    const settings = {
      fitWidth: fitWidthToggle.checked,
      zenMode: zenModeToggle.checked,
      widthPercent: parseInt(widthSlider.value, 10),
      bgColor: getActiveColor(),
      hideMouse: hideMouseToggle.checked,
      autoNext: autoNextToggle.checked,
    };

    chrome.storage.local.set(settings, () => {
      flashStatus();
    });
  }

  /**
   * Get the currently active background color
   */
  function getActiveColor() {
    const activeBtn = document.querySelector(".color-btn.active");
    return activeBtn ? activeBtn.dataset.color : DEFAULT_SETTINGS.bgColor;
  }

  /**
   * Flash the status badge to indicate save
   */
  function flashStatus() {
    statusBadge.style.background = "rgba(0, 229, 106, 0.2)";
    statusBadge.style.borderColor = "rgba(0, 229, 106, 0.45)";
    setTimeout(() => {
      statusBadge.style.background = "";
      statusBadge.style.borderColor = "";
    }, 600);
  }

  /**
   * Load settings from storage and apply to UI
   */
  function loadSettings() {
    chrome.storage.local.get(DEFAULT_SETTINGS, (storedSettings) => {
      const settings = normalizeSettings(storedSettings);
      fitWidthToggle.checked = settings.fitWidth;
      zenModeToggle.checked = settings.zenMode;
      hideMouseToggle.checked = settings.hideMouse;
      autoNextToggle.checked = settings.autoNext;
      widthSlider.value = settings.widthPercent;
      widthValue.textContent = settings.widthPercent + "%";
      widthSlider.setAttribute("aria-valuetext", settings.widthPercent + "%");

      // Update slider row visibility
      updateSliderVisibility(settings.fitWidth);

      // Set active color button
      colorButtons.forEach((btn) => {
        btn.classList.toggle(
          "active",
          btn.dataset.color === settings.bgColor
        );
      });
    });
  }

  /**
   * Show/hide the width slider based on fitWidth toggle
   */
  function updateSliderVisibility(fitWidthEnabled) {
    widthSlider.disabled = !fitWidthEnabled;
    if (fitWidthEnabled) {
      sliderRow.style.opacity = "1";
      sliderRow.style.pointerEvents = "auto";
    } else {
      sliderRow.style.opacity = "0.35";
      sliderRow.style.pointerEvents = "none";
    }
  }

  // ===== Event Listeners =====

  fitWidthToggle.addEventListener("change", () => {
    updateSliderVisibility(fitWidthToggle.checked);
    saveSettings();
  });

  zenModeToggle.addEventListener("change", () => {
    saveSettings();
  });

  hideMouseToggle.addEventListener("change", () => {
    saveSettings();
  });

  autoNextToggle.addEventListener("change", () => {
    saveSettings();
  });

  widthSlider.addEventListener("input", () => {
    widthValue.textContent = widthSlider.value + "%";
    widthSlider.setAttribute("aria-valuetext", widthSlider.value + "%");
  });

  widthSlider.addEventListener("change", () => {
    saveSettings();
  });

  colorButtons.forEach((btn) => {
    btn.addEventListener("click", () => {
      colorButtons.forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
      saveSettings();
    });
  });

  resetBtn.addEventListener("click", () => {
    chrome.storage.local.set(DEFAULT_SETTINGS, () => {
      loadSettings();
      flashStatus();
    });
  });

  /**
   * Translate UI elements based on data-locale attributes
   */
  function localizeUI() {
    document.documentElement.lang = chrome.i18n.getUILanguage().split("-")[0];
    const localeElements = document.querySelectorAll("[data-locale]");
    localeElements.forEach((el) => {
      const key = el.dataset.locale;
      const message = chrome.i18n.getMessage(key);
      if (message) {
        el.textContent = message;
      }
    });

    const localizedAttributes = [
      ["data-locale-aria-label", "aria-label"],
      ["data-locale-title", "title"],
    ];
    localizedAttributes.forEach(([dataAttribute, targetAttribute]) => {
      document.querySelectorAll(`[${dataAttribute}]`).forEach((el) => {
        const message = chrome.i18n.getMessage(el.getAttribute(dataAttribute));
        if (message) {
          el.setAttribute(targetAttribute, message);
        }
      });
    });
  }

  // ===== Initialize =====
  localizeUI();
  loadSettings();
})();
