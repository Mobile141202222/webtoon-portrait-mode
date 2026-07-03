/**
 * Webtoon Portrait Mode - Content Script
 * Injects dynamic CSS into the Webtoon viewer page to fit images to the viewport width.
 *
 * Actual Webtoon DOM hierarchy (discovered from page source):
 *   body.th
 *     #wrap
 *       #container
 *         .tool_area#toolbar          ← top navigation bar
 *         #content.viewer             ← main content wrapper
 *           .cont_box#_viewerBox      ← viewer box container
 *             .viewer_lst             ← list wrapper
 *               .viewer_img._img_viewer_area#_imageList  ← image list container
 *                 img._images[width="690"][height="1000.0"]  ← comic panel images
 *
 * IMPORTANT: Webtoon uses scroll-based lazy loading. Images start with
 *   src="...bg_transparency.png" (a 1x1 transparent placeholder)
 *   and have the real URL in data-url="...".
 *   Webtoon's JS swaps src when the image scrolls into view. Expanding the
 *   viewer invalidates the offsets cached by that loader, so this extension
 *   observes the resized images itself and swaps data-url into src nearby.
 *   We still keep #_imageList in normal block flow (no flexbox).
 */

(function () {
  "use strict";

  const STYLE_ID = "webtoon-portrait-fit-style";
  const PREVENT_FLASH_STYLE_ID = "wpf-prevent-flash";

  // Synchronously inject a neutral dark gray background (#121212) immediately at document_start.
  // This styles the page before it paints the first frame while the storage settings load asynchronously.
  // This element is removed by loadAndApply once settings are fetched and custom styles are applied.
  const preventFlashStyle = document.createElement("style");
  preventFlashStyle.id = PREVENT_FLASH_STYLE_ID;
  preventFlashStyle.setAttribute("type", "text/css");
  preventFlashStyle.textContent = `
    html, body {
      background-color: #121212 !important;
      color: #121212 !important;
    }
  `;
  const targetEl = document.documentElement || document.head;
  if (targetEl) {
    targetEl.appendChild(preventFlashStyle);
  } else {
    const observer = new MutationObserver(() => {
      const el = document.documentElement || document.head;
      if (el) {
        el.appendChild(preventFlashStyle);
        observer.disconnect();
      }
    });
    observer.observe(document, { childList: true, subtree: true });
  }

  const IMAGE_SELECTOR = "#_imageList img._images";
  const LAZY_SOURCE_ATTRIBUTES = [
    "data-url",
    "data-src",
    "data-original",
    "data-lazy-src",
  ];

  let imageObserver = null;
  let imageListObserver = null;
  let observedImageList = null;
  let loadingBridgeRunning = false;

  // Default settings
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

  /**
   * Generate the CSS string based on current settings
   */
  function generateCSS(settings) {
    const { fitWidth, zenMode, widthPercent, bgColor, hideMouse } = settings;
    const isDark = bgColor && bgColor !== "original";
    const textColor = isDark ? "rgba(255, 255, 255, 0.85)" : "rgba(0, 0, 0, 0.75)";
    const ringBg = isDark ? "rgba(255, 255, 255, 0.15)" : "rgba(0, 0, 0, 0.1)";
    
    // Premium Card elevation styling
    const cardBg = isDark ? "rgba(255, 255, 255, 0.04)" : "#ffffff";
    const cardBorder = isDark ? "rgba(255, 255, 255, 0.08)" : "rgba(0, 0, 0, 0.1)";
    const cardShadow = isDark ? "0 4px 20px rgba(0, 0, 0, 0.25)" : "0 2px 8px rgba(0, 0, 0, 0.05)";
    
    let css = "";

    const isViewerPage = window.location.pathname.includes("/viewer");

    if (fitWidth && isViewerPage) {
      const w = Math.min(Math.max(widthPercent, 40), 100);
      css += `
        /* ===== Webtoon Portrait Mode: Full-Width Override ===== */

        /* Prevent horizontal overflow without turning body into a separate
           scroll container. overflow-x:hidden makes overflow-y compute to auto
           and breaks Webtoon's window-based lazy-loader offsets. */
        html, body {
          overflow-x: clip !important;
        }

        /* Reset ALL ancestor containers to allow full viewport width.
           DO NOT change display property — keep block flow intact for lazy loading. */
        body,
        #wrap,
        #container,
        #content,
        #content.viewer,
        .cont_box,
        .cont_box#_viewerBox,
        .viewer_lst,
        .viewer_img,
        .viewer_img._img_viewer_area,
        #_imageList {
          width: 100% !important;
          max-width: 100% !important;
          min-width: 0 !important;
          padding-left: 0 !important;
          padding-right: 0 !important;
          margin-left: 0 !important;
          margin-right: 0 !important;
          box-sizing: border-box !important;
        }

        /* Center images using text-align on parent (safe — doesn't break layout flow) */
        #_imageList,
        .viewer_img,
        .viewer_lst {
          text-align: center !important;
        }

        /* Only resize actual episode images. Broad selectors can also resize
           Webtoon's helper/advertising images and disturb its scroll offsets. */
        #_imageList img._images {
          width: ${w}% !important;
          max-width: 100vw !important;
          min-width: 0 !important;
          display: block !important;
          margin-left: auto !important;
          margin-right: auto !important;
        }

        /* Preserve each placeholder's original aspect ratio while its width is
           expanded. Keeping the old fixed pixel height makes all later lazy-load
           offsets stale as soon as the viewer is widened. */
        #_imageList img._images:not([data-wpf-state="loaded"]) {
          height: auto !important;
          aspect-ratio: var(--wpf-image-ratio, 69 / 100) !important;
        }

        /* The real bitmap controls height only after its load event fires. */
        #_imageList img._images[data-wpf-state="loaded"] {
          height: auto !important;
          aspect-ratio: auto !important;
          object-fit: contain !important;
        }

        /* Override fixed width from other containers */
        .detail_body,
        .detail_lst,
        .episode_cont,
        .episode_area {
          width: 100% !important;
          max-width: 100% !important;
        }

        /* Toolbar */
        .tool_area,
        .tool_area#toolbar,
        .tool_area#toolbarSensor {
          width: 100% !important;
          max-width: 100% !important;
        }
      `;
    }

    // Background color override
    if (bgColor && bgColor !== "original") {
      css += `
        /* ===== Webtoon Portrait Mode: Flat Page Backgrounds ===== */
        body,
        #wrap,
        #container,
        #content,
        #content.viewer,
        .cont_box,
        .cont_box#_viewerBox,
        .cont_box#_bottomDisplay,
        .viewer_lst,
        .viewer_img,
        .viewer_img._img_viewer_area,
        #_imageList,
        .detail_body,
        .episode_area,
        .episode_cont,
        .episode_lst,
        .episode_lst li,
        .episode_lst li a,
        #header,
        .header_wrap,
        .header_inner,
        #footer,
        .footer,
        .snb,
        .snb_wrap,
        .snb_bar,
        .nav_sub_wrap,
        .notice_area,
        .lst_type li,
        .lst_type li a,
        .daily_lst,
        .genre_lst,
        .ranking_lst,
        .rank_lst,
        .div_snb,
        .snb_area,
        .aside,
        .detail_bg,
        .detail_header,
        .detail_lst ul,
        .my_comments_commentList,
        #commentList,
        .lst_type1,
        .foot_app,
        .foot_cont,
        .foot_down_msg,
        .footapp_icon_cont {
          background-color: ${bgColor} !important;
          background: ${bgColor} !important;
        }

        /* ===== Webtoon Portrait Mode: Elevated Cards & Dropdowns ===== */
        .card,
        .card_area,
        .section_card,
        .discover_item,
        .discover_lst li,
        .daily_card,
        .card_wrap,
        .card_lst li,
        .genre_lst li,
        .ranking_lst li,
        .rank_lst li,
        .aside.detail,
        .detail_lst,
        .detail_install_app,
        .ly_loginbox,
        .ly_autocomplete,
        .ly_creator,
        .ly_creator_in,
        .ly_wrap,
        .ly_box,
        .ly_area,
        .ly_lang,
        .my_comments_commentArea,
        #my_comments_commentArea,
        .lst_type1 li,
        .lst_type1 li a,
        [class*="type_white"],
        [class*="account_"] {
          background-color: ${cardBg} !important;
          background: ${cardBg} !important;
          border: 1px solid ${cardBorder} !important;
          border-radius: 8px !important;
          box-shadow: ${cardShadow} !important;
          box-sizing: border-box !important;
        }

        /* ===== Webtoon Portrait Mode: Individual List Item Rows (Comments & Episode Lists) ===== */
        .my_comments_commentItem,
        ._episodeItem {
          background: transparent !important;
          background-color: transparent !important;
          border-bottom: 1px solid ${cardBorder} !important;
          border-radius: 0 !important;
          box-shadow: none !important;
          box-sizing: border-box !important;
        }
        .my_comments_commentItem {
          padding: 20px !important;
          margin-bottom: 0 !important;
        }
        .my_comments_commentItem:last-child,
        ._episodeItem:last-child {
          border-bottom: none !important;
        }
        .thmb {
          background: transparent !important;
          background-color: transparent !important;
        }

        /* ===== Dark Mode: Broad Text Color Override ===== */
        /* Override ALL text within the page containers for dark bg readability.
           Use wildcard selectors on known containers to catch all child elements. */

        /* --- Page-level text --- */
        #content.viewer,
        #content.viewer > *,
        .cont_box#_bottomDisplay,
        .cont_box#_bottomDisplay *,
        #bottomEpisodeList,
        #bottomEpisodeList *,
        .episode_area,
        .episode_area *,
        .detail_body,
        .detail_body *,
        .detail_lst,
        .detail_lst *,
        #header a,
        #header span,
        #header button,
        #header li,
        #header p,
        .snb a,
        .snb span,
        .snb li,
        .snb p,
        #container a,
        #container span,
        #container strong,
        #container em,
        #container p,
        #container h1,
        #container h2,
        #container h3,
        #container h4,
        #container h5,
        #container h6,
        #container li,
        #footer a,
        #footer span,
        #footer p,
        #footer li,
        .foot_app,
        .foot_app *,
        .foot_cont,
        .foot_cont * {
          color: rgba(255, 255, 255, 0.85) !important;
        }

        /* --- Headers, titles, author --- */
        .viewer_header,
        .viewer_header *,
        .subj_info,
        .subj_info *,
        .author_area,
        .author_area *,
        .author,
        .author *,
        .writer,
        .writer *,
        .creator,
        .creator *,
        .info_area,
        .info_area * {
          color: #ffffff !important;
        }

        /* --- Links & Hovers --- */
        #content.viewer a:hover,
        .cont_box a:hover,
        #container a:hover,
        #header a:hover,
        #footer a:hover,
        .episode_area a:hover,
        .episode_area a:hover *,
        #bottomEpisodeList a:hover,
        #bottomEpisodeList a:hover * {
          color: #00e56a !important;
        }

        /* --- Active navigation items & badges --- */
        .on,
        .on *,
        .active,
        .active *,
        .snb li.on a,
        .snb li.on a *,
        .snb_tab.on,
        ._snb_tab_a.on,
        ._snb_tab_a.on *,
        #container .on,
        #container .on * {
          color: #00e56a !important;
          border-color: #00e56a !important;
        }

        /* --- Inputs, Search fields & Comments textareas --- */
        input[type="text"],
        input[type="search"],
        textarea,
        select {
          background-color: rgba(255, 255, 255, 0.08) !important;
          border: 1px solid rgba(255, 255, 255, 0.15) !important;
          color: #ffffff !important;
        }
        input::placeholder,
        textarea::placeholder {
          color: rgba(255, 255, 255, 0.4) !important;
        }

        /* --- Buttons inside Container (e.g. Edit/Add account settings) --- */
        #container button:not([class*="toggle"]):not([class*="switch"]):not([role="switch"]),
        #container .btn:not([class*="toggle"]):not([class*="switch"]):not([role="switch"]),
        #container [class*="btn_"]:not([class*="toggle"]):not([class*="switch"]):not([role="switch"]) {
          background-color: rgba(255, 255, 255, 0.08) !important;
          background: rgba(255, 255, 255, 0.08) !important;
          border: 1px solid rgba(255, 255, 255, 0.15) !important;
          color: #ffffff !important;
          cursor: pointer !important;
          transition: background-color 0.2s ease, color 0.2s ease !important;
        }
        #container button:not([class*="toggle"]):not([class*="switch"]):not([role="switch"]):hover,
        #container .btn:not([class*="toggle"]):not([class*="switch"]):not([role="switch"]):hover,
        #container [class*="btn_"]:not([class*="toggle"]):not([class*="switch"]):not([role="switch"]):hover {
          background-color: rgba(255, 255, 255, 0.15) !important;
          color: #00e56a !important;
          border-color: #00e56a !important;
        }

        /* --- Borders & dividers --- */
        .cont_box#_bottomDisplay hr,
        .cont_box#_bottomDisplay [class*="divider"],
        .cont_box#_bottomDisplay [class*="line"],
        #wrap *,
        #container *,
        #footer *,
        .snb * {
          border-color: rgba(255, 255, 255, 0.12) !important;
        }

        /* ===== Dark Mode: Webtoon Comment Component (wcc_) ===== */
        /* The global webtoons.com uses wcc_ prefixed classes for comments */

        /* Comment containers */
        [class*="wcc_"] {
          color: rgba(255, 255, 255, 0.85) !important;
        }

        /* Author names */
        [class*="wcc_CommentHeader__name"] {
          color: #ffffff !important;
          font-weight: 600 !important;
        }

        /* Comment body text */
        [class*="wcc_CommentBody__root"],
        [class*="wcc_CommentBody__root"] p,
        [class*="wcc_CommentBody__root"] span {
          color: rgba(255, 255, 255, 0.95) !important;
        }

        /* Timestamps */
        [class*="wcc_CommentHeader__createdAt"] {
          color: rgba(255, 255, 255, 0.4) !important;
        }

        /* Like/Dislike reaction buttons */
        [class*="wcc_CommentReaction__action"] {
          color: rgba(255, 255, 255, 0.7) !important;
          transition: color 0.2s ease !important;
        }
        [class*="wcc_CommentReaction__action"]:hover {
          color: #ffffff !important;
        }
        [class*="wcc_CommentReaction"] svg {
          fill: rgba(255, 255, 255, 0.6) !important;
        }
        [class*="wcc_CommentReaction"] svg:hover {
          fill: #ffffff !important;
        }

        /* Reply toggle button */
        [class*="wcc_ReplyFolderToggle"],
        [class*="wcc_CommentItem__replyFolderToggle"] {
          color: #00e56a !important;
          font-weight: 600 !important;
        }

        /* Expanded reply threads use an opaque light surface by default.
           Override the folder itself so light text remains readable. */
        [class*="wcc_ReplyFolder__root"] {
          background-color: ${bgColor} !important;
          background: ${bgColor} !important;
          color: rgba(255, 255, 255, 0.85) !important;
          border-color: rgba(255, 255, 255, 0.12) !important;
        }

        /* Sort order tabs */
        [class*="wcc_SortOrderTab__root"] {
          color: rgba(255, 255, 255, 0.5) !important;
          transition: color 0.2s ease !important;
        }
        [class*="wcc_SortOrderTab__active"],
        [class*="wcc_SortOrderTab__root"]:hover {
          color: #00e56a !important;
        }

        /* Comment write area / textarea / Editor */
        [class*="wcc_CommentWrite"],
        [class*="wcc_CommentWrite__root"],
        [class*="wcc_CommentWrite__box"],
        [class*="wcc_CommentWrite__area"],
        [class*="wcc_CommentWrite__container"],
        [class*="wcc_CommentWrite"] [class*="write"],
        [class*="wcc_CommentWrite"] [class*="box"],
        [class*="wcc_CommentWrite"] [class*="area"],
        [class*="wcc_Editor"],
        [class*="wcc_Editor_root"],
        [class*="wcc_Editor__editor"],
        [class*="TextEditor_TextEditorCore"],
        [class*="TextEditor_EditorCore"],
        [class*="TextEditor_ActionBar"] {
          background-color: ${bgColor} !important;
          background: ${bgColor} !important;
          border-color: rgba(255, 255, 255, 0.12) !important;
        }

        [class*="wcc_CommentWrite"],
        [class*="wcc_CommentWrite"] *,
        [class*="wcc_Editor"],
        [class*="wcc_Editor"] *,
        [class*="TextEditor_"] * {
          color: rgba(255, 255, 255, 0.9) !important;
        }

        [class*="wcc_CommentWrite"] textarea,
        [class*="wcc_CommentWrite"] input,
        [class*="wcc_CommentWrite"] [class*="textarea"],
        [class*="wcc_CommentWrite"] [class*="input_box"],
        [class*="TextEditor_EditorCore"] textarea,
        [class*="TextEditor_EditorCore"] [contenteditable="true"],
        [class*="TextEditor_EditorCore"] [class*="scrollArea"],
        [class*="wcc_Editor"] textarea,
        [class*="wcc_Editor"] [contenteditable="true"],
        [class*="wcc_Editor"] [class*="scrollArea"],
        [class*="wcc_Editor"] [class*="editor"] {
          background-color: rgba(255, 255, 255, 0.06) !important;
          background: rgba(255, 255, 255, 0.06) !important;
          border: 1px solid rgba(255, 255, 255, 0.15) !important;
          color: #ffffff !important;
        }

        [class*="wcc_CommentWrite"] textarea::placeholder,
        [class*="wcc_CommentWrite"] input::placeholder,
        [class*="TextEditor_"] [class*="placeholder"],
        [class*="wcc_Editor"] [class*="placeholder"],
        [class*="TextEditor_"] textarea::placeholder,
        [class*="TextEditor_"] input::placeholder {
          color: rgba(255, 255, 255, 0.35) !important;
          background: transparent !important;
        }

        /* Action Bar Submit Buttons */
        [class*="TextEditor_ActionBar"] button,
        [class*="wcc_Editor__actionBar"] button,
        [class*="TextEditor_ActionBar"] [role="button"],
        [class*="wcc_Editor__actionBar"] [role="button"] {
          background-color: #00e56a !important;
          background: #00e56a !important;
          color: #000000 !important;
          border: none !important;
          border-radius: 4px !important;
          font-weight: bold !important;
        }
        [class*="TextEditor_ActionBar"] button:hover,
        [class*="wcc_Editor__actionBar"] button:hover,
        [class*="TextEditor_ActionBar"] [role="button"]:hover,
        [class*="wcc_Editor__actionBar"] [role="button"]:hover {
          background-color: #00be58 !important;
          background: #00be58 !important;
          color: #000000 !important;
        }
        [class*="TextEditor_ActionBar"] button:disabled,
        [class*="TextEditor_ActionBar"] button[disabled],
        [class*="wcc_Editor__actionBar"] button:disabled,
        [class*="wcc_Editor__actionBar"] button[disabled] {
          background-color: rgba(255, 255, 255, 0.1) !important;
          background: rgba(255, 255, 255, 0.1) !important;
          color: rgba(255, 255, 255, 0.3) !important;
          cursor: not-allowed !important;
        }

        /* Comment count / title */
        [class*="wcc_CommentCount"],
        [class*="wcc_CommentTitle"] {
          color: #ffffff !important;
        }

        /* Catch-all for any other wcc_ text elements */
        [class*="wcc_"] span,
        [class*="wcc_"] p,
        [class*="wcc_"] a,
        [class*="wcc_"] div,
        [class*="wcc_"] button {
          color: inherit !important;
        }

        /* ===== Dark Mode: Fallback for non-wcc_ comment selectors (u_cbox) ===== */
        /* Some older or Korean versions use u_cbox_ classes (Naver Comment widget) */
        #cbox_module,
        [class*="u_cbox_wrap"],
        [class*="u_cbox_box"],
        [class*="u_cbox_area"],
        [class*="u_cbox_head"],
        [class*="u_cbox_comment"],
        [class*="u_cbox_comment_box"],
        [class*="u_cbox_write"],
        [class*="u_cbox_write_box"],
        [class*="u_cbox_write_area"] {
          background-color: ${bgColor} !important;
          background: ${bgColor} !important;
          border-color: rgba(255, 255, 255, 0.12) !important;
        }

        [class*="u_cbox"] {
          color: rgba(255, 255, 255, 0.85) !important;
        }

        [class*="u_cbox"] textarea,
        [class*="u_cbox"] input[type="text"],
        [class*="u_cbox"] .u_cbox_text,
        [class*="u_cbox_write_area"],
        [class*="u_cbox_write_box"] {
          background-color: rgba(255, 255, 255, 0.06) !important;
          border-color: rgba(255, 255, 255, 0.15) !important;
          color: #ffffff !important;
        }

        [class*="u_cbox"] textarea::placeholder,
        [class*="u_cbox"] input::placeholder {
          color: rgba(255, 255, 255, 0.4) !important;
        }

        [class*="u_cbox_nick"],
        [class*="u_cbox_name"],
        [class*="u_cbox_info"] {
          color: #ffffff !important;
        }

        [class*="u_cbox_contents"] {
          color: rgba(255, 255, 255, 0.95) !important;
        }

        [class*="u_cbox_date"] {
          color: rgba(255, 255, 255, 0.45) !important;
        }

        [class*="u_cbox_count"],
        [class*="u_cbox_cnt"] {
          color: #00e56a !important;
        }

        [class*="u_cbox"] .u_cbox_btn_upload,
        [class*="u_cbox"] [class*="btn_upload"],
        [class*="u_cbox"] button[type="submit"] {
          background-color: #00e56a !important;
          background: #00e56a !important;
          color: #000000 !important;
          border: none !important;
          text-shadow: none !important;
        }
        [class*="u_cbox"] .u_cbox_btn_upload:hover,
        [class*="u_cbox"] [class*="btn_upload"]:hover,
        [class*="u_cbox"] button[type="submit"]:hover {
          background-color: #00be58 !important;
          background: #00be58 !important;
          color: #000000 !important;
        }

        [class*="u_cbox_cleanbot"],
        [class*="u_cbox_cleanbot"] *,
        [class*="u_cbox_sort"],
        [class*="u_cbox_sort"] *,
        [class*="u_cbox_label"] {
          color: rgba(255, 255, 255, 0.8) !important;
        }

        [class*="u_cbox_page"] a,
        [class*="u_cbox_page"] span {
          color: rgba(255, 255, 255, 0.7) !important;
          border-color: rgba(255, 255, 255, 0.15) !important;
          background-color: transparent !important;
        }
        [class*="u_cbox_page"] a:hover {
          color: #00e56a !important;
          background-color: rgba(255, 255, 255, 0.05) !important;
        }
        [class*="u_cbox_page"] .u_cbox_num_page.u_cbox_on,
        [class*="u_cbox_page"] [class*="u_cbox_on"] {
          color: #00e56a !important;
          font-weight: bold !important;
        }

        [class*="u_cbox_btn_reply"],
        [class*="u_cbox_btn_re"],
        [class*="u_cbox_work"] a,
        [class*="u_cbox_comment_work"] a {
          color: #00e56a !important;
          font-weight: 500 !important;
        }

        [class*="u_cbox_btn_recom"],
        [class*="u_cbox_btn_unrecom"] {
          background-color: rgba(255, 255, 255, 0.05) !important;
          border-color: rgba(255, 255, 255, 0.12) !important;
          color: rgba(255, 255, 255, 0.75) !important;
        }
        [class*="u_cbox_btn_recom"]:hover {
          color: #00e56a !important;
          background-color: rgba(255, 255, 255, 0.1) !important;
        }
        [class*="u_cbox_btn_unrecom"]:hover {
          color: #ff4a4a !important;
          background-color: rgba(255, 255, 255, 0.1) !important;
        }

        /* ===== Dark Mode: Bottom Episode List & Navigation ===== */
        .episode_area,
        .episode_area *,
        .episode_cont,
        .episode_cont *,
        .episode_lst,
        .episode_lst *,
        #bottomEpisodeList,
        #bottomEpisodeList * {
          background-color: ${bgColor} !important;
          border-color: rgba(255, 255, 255, 0.12) !important;
        }

        /* Thumbnail frame borders */
        .episode_lst li .thmb,
        .episode_lst li a .thmb {
          border: 2px solid rgba(255, 255, 255, 0.15) !important;
          background-color: ${bgColor} !important;
          box-shadow: none !important;
        }

        /* Active episode indicator (accent color) */
        .episode_lst li a.on,
        .episode_lst li.on a,
        .episode_lst li a.on .thmb,
        .episode_lst li.on a .thmb,
        .episode_lst li.on .thmb img {
          border-color: #00e56a !important;
          outline-color: #00e56a !important;
        }

        /* Font color inside bottom episode list */
        .episode_lst li a,
        .episode_lst li .tx {
          color: rgba(255, 255, 255, 0.85) !important;
        }
        .episode_lst li a.on .tx,
        .episode_lst li.on a .tx {
          color: #00e56a !important;
          font-weight: bold !important;
        }
        .episode_lst li a:hover .tx {
          color: #00e56a !important;
        }

        /* ===== Dark Mode: SVG icon inversion ===== */
        .cont_box#_bottomDisplay svg,
        [class*="wcc_"] svg {
          fill: currentColor !important;
          color: inherit !important;
        }

        /* ===== Dark Mode: Input / Button fixes ===== */
        .cont_box#_bottomDisplay input,
        .cont_box#_bottomDisplay textarea,
        .cont_box#_bottomDisplay select {
          background-color: rgba(255, 255, 255, 0.04) !important;
          border-color: rgba(255, 255, 255, 0.15) !important;
          color: #ffffff !important;
        }

        .cont_box#_bottomDisplay button {
          color: rgba(255, 255, 255, 0.8) !important;
          transition: color 0.2s ease !important;
        }
        .cont_box#_bottomDisplay button:hover {
          color: #ffffff !important;
        }

        /* Images should NOT be affected by text color */
        #_imageList img,
        .episode_area img,
        #bottomEpisodeList img {
          color: initial !important;
        }
      `;
    }

    // Zen Mode — hide header, footer, navigation, ads, comments
    if (zenMode && isViewerPage) {
      css += `
        /* ===== Webtoon Portrait Mode: Zen Mode ===== */

        /* Top toolbar & navigation */
        .tool_area,
        .tool_area#toolbar,
        .tool_area#toolbarSensor,
        #header,
        .viewer_header,

        /* Bottom navigation & footer */
        #footer,
        .viewer_footer,
        .btn_wrap,
        .paginate,
        #topBtn,

        /* Episode list overlay */
        #topEpisodeList,
        ._btnOpenEpisodeList,

        /* Detail/info sections */
        .ly_module,
        .detail_header,
        .subj_info,
        .author_area,
        .aside,
        .aside.viewer,
        #_bottomDisplay,

        /* Comments */
        .comment_area,
        #cbox_module,
        #cbox_module_wap,
        .reply_area,
        .u_cbox,
        .u_cbox_wrap,

        /* Notices & ads */
        #noticeArea,
        .banner_area,
        .detail_install_btn,
        .g_ad,
        .ad_area,
        .ico_info_help,
        [class*="ad_banner"],
        [class*="banner"],

        /* Social sharing */
        .social_area,
        ._btnSocial {
          display: none !important;
        }

        /* Reclaim vertical space by removing top padding/margin */
        .cont_box,
        .cont_box#_viewerBox,
        #content,
        #content.viewer {
          padding-top: 0 !important;
          margin-top: 0 !important;
        }
      `;
    }

    if (hideMouse && isViewerPage) {
      css += `
        /* ===== Webtoon Portrait Mode: Auto-Hide Mouse ===== */
        #content.viewer.wpf-hide-cursor-active,
        #content.viewer.wpf-hide-cursor-active *,
        #_imageList.wpf-hide-cursor-active,
        #_imageList.wpf-hide-cursor-active * {
          cursor: none !important;
        }
      `;
    }

    if (isViewerPage) {
      // Auto-Next Episode styles
      css += `
        /* ===== Webtoon Portrait Mode: Auto-Next Episode ===== */
        .wpf-auto-next-container {
          display: flex !important;
          flex-direction: column !important;
          align-items: center !important;
          justify-content: center !important;
          width: 100% !important;
          height: 150px !important;
          margin-top: 20px !important;
          padding-bottom: 10px !important;
          box-sizing: border-box !important;
          font-family: 'Inter', -apple-system, sans-serif !important;
          color: #ffffff !important;
          position: relative !important;
          overflow: hidden !important;
          background-color: transparent !important;
        }

        .wpf-auto-prev-container {
          display: flex !important;
          flex-direction: column !important;
          align-items: center !important;
          justify-content: center !important;
          position: fixed !important;
          top: 16px !important;
          left: 50% !important;
          z-index: 2147483646 !important;
          width: 320px !important;
          height: 132px !important;
          padding: 14px 20px !important;
          box-sizing: border-box !important;
          border: 1px solid ${cardBorder} !important;
          border-radius: 14px !important;
          background: ${isDark ? 'rgba(5, 8, 6, 0.94)' : 'rgba(255, 255, 255, 0.96)'} !important;
          box-shadow: ${cardShadow} !important;
          font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif !important;
          color: ${textColor} !important;
          opacity: 0 !important;
          visibility: hidden !important;
          pointer-events: none !important;
          transform: translate(-50%, -12px) !important;
          transition: opacity 0.15s ease, transform 0.15s ease, visibility 0.15s ease !important;
        }

        .wpf-auto-prev-container.wpf-active {
          opacity: 1 !important;
          visibility: visible !important;
          transform: translate(-50%, 0) !important;
        }

        .wpf-auto-prev-container .wpf-auto-next-label {
          margin-bottom: 8px !important;
          font-size: 14px !important;
        }

        .wpf-auto-prev-container .wpf-auto-next-loader-wrap,
        .wpf-auto-prev-container .wpf-auto-next-svg {
          width: 64px !important;
          height: 64px !important;
        }

        .wpf-auto-next-label {
          font-size: 16px !important;
          font-weight: 600 !important;
          margin-bottom: 20px !important;
          letter-spacing: 0.5px !important;
          color: ${textColor} !important;
          text-shadow: ${isDark ? '0 2px 4px rgba(0, 0, 0, 0.5)' : 'none'} !important;
          transition: all 0.3s ease !important;
        }

        .wpf-auto-next-loader-wrap {
          position: relative !important;
          width: 80px !important;
          height: 80px !important;
          display: flex !important;
          align-items: center !important;
          justify-content: center !important;
        }

        .wpf-auto-next-svg {
          transform: rotate(-90deg) !important;
          width: 80px !important;
          height: 80px !important;
        }

        .wpf-auto-next-bg-circle {
          fill: none !important;
          stroke: ${ringBg} !important;
          stroke-width: 6px !important;
        }

        .wpf-auto-next-progress-circle {
          fill: none !important;
          stroke: #00e56a !important;
          stroke-width: 6px !important;
          stroke-linecap: round !important;
          stroke-dasharray: 251.2 !important;
          stroke-dashoffset: 251.2 !important;
          transition: stroke-dashoffset 0.05s linear, stroke 0.3s ease !important;
        }

        .wpf-auto-next-icon {
          position: absolute !important;
          top: 50% !important;
          left: 50% !important;
          transform: translate(-50%, -50%) !important;
          width: 24px !important;
          height: 24px !important;
          color: #00e56a !important;
          transition: all 0.3s ease !important;
          display: flex !important;
          align-items: center !important;
          justify-content: center !important;
        }

        @keyframes wpf-rotate {
          0% { transform: translate(-50%, -50%) rotate(0deg); }
          100% { transform: translate(-50%, -50%) rotate(360deg); }
        }

        .wpf-auto-next-icon.wpf-loading {
          animation: wpf-rotate 0.8s linear infinite !important;
          border: 3px solid rgba(0, 229, 106, 0.3) !important;
          border-top: 3px solid #00e56a !important;
          border-radius: 50% !important;
          width: 24px !important;
          height: 24px !important;
          box-sizing: border-box !important;
        }
      `;
    }

    return css;
  }

  /**
   * Inject or update the <style> element
   */
  function applyStyles(settings) {
    let styleEl = document.getElementById(STYLE_ID);
    if (!styleEl) {
      styleEl = document.createElement("style");
      styleEl.id = STYLE_ID;
      styleEl.setAttribute("type", "text/css");
      
      const target = document.head || document.documentElement;
      if (target) {
        target.appendChild(styleEl);
      } else {
        document.addEventListener("DOMContentLoaded", () => {
          const t = document.head || document.documentElement;
          if (t) t.appendChild(styleEl);
        });
      }
    }
    styleEl.textContent = generateCSS(settings);
  }

  /**
   * Remove injected styles (if extension is disabled)
   */


  function isPlaceholderSource(source) {
    return (
      !source ||
      /(?:bg[_-]?transparency|transparent|placeholder|blank\.gif)/i.test(
        source
      )
    );
  }

  function getLazySource(image) {
    for (const attribute of LAZY_SOURCE_ATTRIBUTES) {
      const source = image.getAttribute(attribute);
      if (source && !isPlaceholderSource(source.trim())) {
        return source.trim();
      }
    }
    return "";
  }

  function reserveImageRatio(image) {
    const width = Number.parseFloat(image.getAttribute("width"));
    const height = Number.parseFloat(image.getAttribute("height"));

    if (width > 0 && height > 0) {
      image.style.setProperty("--wpf-image-ratio", `${width} / ${height}`);
    }
  }

  function markImageLoaded(image) {
    image.dataset.wpfState = "loaded";
  }

  function isViewerImage(target) {
    return (
      target instanceof HTMLImageElement && target.matches(IMAGE_SELECTOR)
    );
  }

  function handleImageLoad(event) {
    if (
      isViewerImage(event.target) &&
      !isPlaceholderSource(event.target.getAttribute("src")) &&
      event.target.naturalWidth > 1
    ) {
      markImageLoaded(event.target);
    }
  }

  function handleImageError(event) {
    if (
      isViewerImage(event.target) &&
      !isPlaceholderSource(event.target.getAttribute("src"))
    ) {
      event.target.dataset.wpfState = "error";
    }
  }

  /**
   * Keep the same amount of original Webtoon content ready after images are
   * widened. A fixed pixel margin becomes much too short when a 690px panel is
   * rendered at desktop width.
   */
  function calculatePreloadDistance(
    viewportHeight,
    renderedWidth,
    originalWidth
  ) {
    const safeViewportHeight = Math.max(Number(viewportHeight) || 0, 1);
    const safeOriginalWidth = Math.max(Number(originalWidth) || 0, 1);
    const scale = Math.max((Number(renderedWidth) || 0) / safeOriginalWidth, 1);
    const scaledWebtoonLookAhead = 3000 * scale;
    const sixViewports = safeViewportHeight * 6;

    return Math.ceil(Math.min(Math.max(scaledWebtoonLookAhead, sixViewports), 24000));
  }

  function getPreloadDistance(imageList) {
    const firstImage = imageList.querySelector(IMAGE_SELECTOR);
    const originalWidth = firstImage
      ? Number.parseFloat(firstImage.getAttribute("width")) || 690
      : 690;
    const renderedWidth = firstImage
      ? firstImage.getBoundingClientRect().width
      : document.documentElement.clientWidth;

    return calculatePreloadDistance(
      window.innerHeight,
      renderedWidth,
      originalWidth
    );
  }

  /**
   * Load the real Webtoon URL instead of relying on Webtoon's cached offsets.
   * Those offsets are calculated for Webtoon's original fixed-width layout and become
   * invalid after the extension expands already-loaded images.
   */
  function loadRealImage(image) {
    const currentSource = image.getAttribute("src") || "";

    if (!isPlaceholderSource(currentSource)) {
      if (image.complete && image.naturalWidth > 1) {
        markImageLoaded(image);
      } else {
        image.dataset.wpfState = "loading";
      }
      return;
    }

    const realSource = getLazySource(image);
    if (!realSource) {
      return;
    }

    image.dataset.wpfState = "loading";
    // Webtoon may set loading="lazy" on these nodes. Once our observer has
    // admitted an image into the look-ahead window, let the request start now.
    image.loading = "eager";
    image.decoding = "async";
    image.setAttribute("src", realSource);

    const lazySrcset = image.getAttribute("data-srcset");
    if (lazySrcset) {
      image.setAttribute("srcset", lazySrcset);
    }
  }

  function prepareImage(image) {
    if (!(image instanceof HTMLImageElement)) {
      return;
    }

    reserveImageRatio(image);
    const currentSource = image.getAttribute("src") || "";

    if (!isPlaceholderSource(currentSource)) {
      loadRealImage(image);
    } else if (imageObserver) {
      imageObserver.observe(image);
    }
  }

  function scanImages(root = document) {
    if (root instanceof HTMLImageElement && root.matches(IMAGE_SELECTOR)) {
      prepareImage(root);
      return;
    }

    if (root.querySelectorAll) {
      root.querySelectorAll(IMAGE_SELECTOR).forEach(prepareImage);
    }
  }

  function startImageLoadingBridge() {
    if (loadingBridgeRunning) {
      scanImages(observedImageList || document);
      return;
    }

    const imageList = document.getElementById("_imageList");
    if (!imageList) {
      return;
    }

    loadingBridgeRunning = true;
    observedImageList = imageList;
    imageList.addEventListener("load", handleImageLoad, true);
    imageList.addEventListener("error", handleImageError, true);

    if ("IntersectionObserver" in window) {
      const preloadDistance = getPreloadDistance(imageList);
      imageObserver = new IntersectionObserver(
        (entries) => {
          entries.forEach((entry) => {
            if (entry.isIntersecting) {
              imageObserver.unobserve(entry.target);
              loadRealImage(entry.target);
            }
          });
        },
        { rootMargin: `1000px 0px ${preloadDistance}px 0px` }
      );
    }

    scanImages(imageList);

    imageListObserver = new MutationObserver((mutations) => {
      mutations.forEach((mutation) => {
        mutation.addedNodes.forEach((node) => {
          if (node.nodeType === Node.ELEMENT_NODE) {
            scanImages(node);
          }
        });
      });
    });
    // New episode panels are inserted under this list. Observing all of body
    // also processes unrelated comments, navigation, and advertisements.
    imageListObserver.observe(imageList, { childList: true, subtree: true });
  }

  function stopImageLoadingBridge() {
    if (!loadingBridgeRunning) {
      return;
    }

    loadingBridgeRunning = false;
    imageObserver?.disconnect();
    imageListObserver?.disconnect();
    observedImageList?.removeEventListener("load", handleImageLoad, true);
    observedImageList?.removeEventListener("error", handleImageError, true);
    imageObserver = null;
    imageListObserver = null;
    observedImageList = null;
  }

  let hideMouseEnabled = false;
  let cursorTimeout = null;
  let isCursorVisible = false;

  function onViewerClick() {
    if (!hideMouseEnabled) return;

    const target = document.querySelector("#content.viewer") || document.querySelector("#_imageList");
    if (!target) return;

    // Show cursor
    target.classList.remove("wpf-hide-cursor-active");
    isCursorVisible = true;

    // Reset timer
    if (cursorTimeout) {
      clearTimeout(cursorTimeout);
    }
    cursorTimeout = setTimeout(() => {
      if (hideMouseEnabled && target) {
        target.classList.add("wpf-hide-cursor-active");
        isCursorVisible = false;
      }
    }, 3000);
  }

  function onViewerMouseMove() {
    if (!hideMouseEnabled) return;
    if (!isCursorVisible) return; // Keep cursor hidden if it hasn't been shown by a click

    const target = document.querySelector("#content.viewer") || document.querySelector("#_imageList");
    if (!target) return;

    // Reset timer
    if (cursorTimeout) {
      clearTimeout(cursorTimeout);
    }
    cursorTimeout = setTimeout(() => {
      if (hideMouseEnabled && target) {
        target.classList.add("wpf-hide-cursor-active");
        isCursorVisible = false;
      }
    }, 3000);
  }

  function onViewerMouseLeave() {
    if (!hideMouseEnabled) return;

    const target = document.querySelector("#content.viewer") || document.querySelector("#_imageList");
    if (!target) return;

    // Immediately hide when leaving target area
    target.classList.add("wpf-hide-cursor-active");
    isCursorVisible = false;
    if (cursorTimeout) {
      clearTimeout(cursorTimeout);
      cursorTimeout = null;
    }
  }

  function applyHideMouseBehavior(enabled) {
    hideMouseEnabled = enabled;
    const target = document.querySelector("#content.viewer") || document.querySelector("#_imageList");

    if (!target) {
      // Retry in 500ms if container is not loaded yet
      if (enabled) {
        setTimeout(() => applyHideMouseBehavior(enabled), 500);
      }
      return;
    }

    // Clean up existing listeners
    target.removeEventListener("click", onViewerClick);
    target.removeEventListener("mousemove", onViewerMouseMove);
    target.removeEventListener("mouseleave", onViewerMouseLeave);
    target.classList.remove("wpf-hide-cursor-active");

    if (cursorTimeout) {
      clearTimeout(cursorTimeout);
      cursorTimeout = null;
    }
    isCursorVisible = false;

    if (!enabled) {
      return;
    }

    // Hide by default initially
    target.classList.add("wpf-hide-cursor-active");

    // Add event listeners
    target.addEventListener("click", onViewerClick);
    target.addEventListener("mousemove", onViewerMouseMove);
    target.addEventListener("mouseleave", onViewerMouseLeave);
  }

  let autoNextEnabled = false;
  let autoNextContainer = null;
  let autoPrevContainer = null;
  let isNavigating = false;
  let nextEpUrl = null;
  let prevEpUrl = null;
  let autoEpisodeRetryTimer = null;

  function getSafeEpisodeHref(element) {
    if (!element) return "";
    if (element.tagName !== "A") {
      element = element.closest?.("a") || element.querySelector?.("a") || element;
    }

    const href = element.getAttribute?.("href") || "";
    if (!href || href === "#" || href.startsWith("javascript:")) return "";

    try {
      const resolved = new URL(href, window.location.href);
      const isWebtoonsHost =
        resolved.hostname === "webtoons.com" ||
        resolved.hostname.endsWith(".webtoons.com");
      return resolved.protocol === "https:" && isWebtoonsHost ? href : "";
    } catch (_error) {
      return "";
    }
  }

  function getAdjacentEpisodeUrl(direction) {
    const isNext = direction === "next";
    const selectors = isNext
      ? [
          ".pg_next",
          ".btn_next",
          "a._nextEpisode",
          'a[class*="pg_next"]',
          'a[class*="btn_next"]',
          "a.next_btn",
          "a.btn-next",
        ]
      : [
          ".pg_prev",
          ".btn_prev",
          "a._prevEpisode",
          'a[class*="pg_prev"]',
          'a[class*="btn_prev"]',
          "a.prev_btn",
          "a.btn-prev",
        ];

    for (const selector of selectors) {
      const href = getSafeEpisodeHref(document.querySelector(selector));
      if (href) return href;
    }

    const allLinks = document.querySelectorAll("a");
    for (const link of allLinks) {
      const href = getSafeEpisodeHref(link);
      if (!href) continue;

      const text = link.textContent.trim().toLowerCase();
      const ariaLabel = link.getAttribute("aria-label")?.toLowerCase() || "";
      const matchesDirection = isNext
        ? text.includes("next episode") ||
          text.includes("ตอนต่อไป") ||
          text.includes("next chapter") ||
          text === "next" ||
          ariaLabel.includes("next")
        : text.includes("previous episode") ||
          text.includes("prev episode") ||
          text.includes("ตอนก่อนหน้า") ||
          text.includes("previous chapter") ||
          text === "previous" ||
          text === "prev" ||
          ariaLabel.includes("previous") ||
          ariaLabel.includes("prev");
      if (matchesDirection) return href;
    }

    try {
      const currentUrl = new URL(window.location.href);
      const episodeNoString =
        currentUrl.searchParams.get("episode_no") ||
        currentUrl.searchParams.get("episodeNo");
      const currentEpisode = Number.parseInt(episodeNoString, 10);
      if (!Number.isFinite(currentEpisode)) return null;

      const targetEpisode = currentEpisode + (isNext ? 1 : -1);
      if (targetEpisode < 1) return null;

      for (const link of allLinks) {
        const href = getSafeEpisodeHref(link);
        if (!href || !/(?:episode|viewer)/i.test(href)) continue;

        const linkUrl = new URL(href, window.location.href);
        const linkEpisodeString =
          linkUrl.searchParams.get("episode_no") ||
          linkUrl.searchParams.get("episodeNo");
        if (Number.parseInt(linkEpisodeString, 10) === targetEpisode) {
          return href;
        }
      }
    } catch (_error) {
      return null;
    }

    return null;
  }

  function getNextEpisodeUrl() {
    return getAdjacentEpisodeUrl("next");
  }

  function getPreviousEpisodeUrl() {
    return getAdjacentEpisodeUrl("previous");
  }

  function createEpisodeProgressMarkup(direction) {
    const isNext = direction === "next";
    const prefix = isNext ? "Next" : "Prev";
    const label = isNext
      ? "Scroll down for next episode"
      : "Scroll up for previous episode";
    const arrow = isNext
      ? '<line x1="12" y1="5" x2="12" y2="19"></line><polyline points="19 12 12 19 5 12"></polyline>'
      : '<line x1="12" y1="19" x2="12" y2="5"></line><polyline points="5 12 12 5 19 12"></polyline>';

    return `
      <div class="wpf-auto-next-label" id="wpfAuto${prefix}Label">${label}</div>
      <div class="wpf-auto-next-loader-wrap">
        <svg class="wpf-auto-next-svg" viewBox="0 0 100 100" aria-hidden="true">
          <circle class="wpf-auto-next-bg-circle" cx="50" cy="50" r="40" />
          <circle class="wpf-auto-next-progress-circle" id="wpfAuto${prefix}Circle" cx="50" cy="50" r="40" />
        </svg>
        <div class="wpf-auto-next-icon" id="wpfAuto${prefix}Icon" aria-hidden="true">
          <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" style="width:100%;height:100%;">${arrow}</svg>
        </div>
      </div>
    `;
  }

  function initAutoNext() {
    if (!autoNextEnabled || isNavigating) return;

    nextEpUrl ||= getNextEpisodeUrl();
    prevEpUrl ||= getPreviousEpisodeUrl();

    const imageList = document.getElementById("_imageList");
    if (nextEpUrl && imageList && !document.getElementById("wpf-auto-next")) {
      autoNextContainer = document.createElement("div");
      autoNextContainer.id = "wpf-auto-next";
      autoNextContainer.className = "wpf-auto-next-container";
      autoNextContainer.innerHTML = createEpisodeProgressMarkup("next");
      imageList.appendChild(autoNextContainer);
    }

    if (prevEpUrl && document.body && !document.getElementById("wpf-auto-prev")) {
      autoPrevContainer = document.createElement("div");
      autoPrevContainer.id = "wpf-auto-prev";
      autoPrevContainer.className = "wpf-auto-prev-container";
      autoPrevContainer.setAttribute("role", "status");
      autoPrevContainer.setAttribute("aria-live", "polite");
      autoPrevContainer.innerHTML = createEpisodeProgressMarkup("previous");
      document.body.appendChild(autoPrevContainer);
    }

    if (
      (!nextEpUrl && !prevEpUrl) ||
      (nextEpUrl && !autoNextContainer) ||
      (prevEpUrl && !autoPrevContainer)
    ) {
      if (!autoEpisodeRetryTimer) {
        autoEpisodeRetryTimer = setTimeout(() => {
          autoEpisodeRetryTimer = null;
          initAutoNext();
        }, 1500);
      }
    }
  }

  function triggerEpisode(direction) {
    const isNext = direction === "next";
    const targetUrl = isNext ? nextEpUrl : prevEpUrl;
    if (isNavigating || !targetUrl) return;
    isNavigating = true;

    const prefix = isNext ? "Next" : "Prev";
    const label = document.getElementById(`wpfAuto${prefix}Label`);
    if (label) {
      label.textContent = isNext
        ? "Loading next episode..."
        : "Loading previous episode...";
      label.style.color = "#00e56a";
    }

    const icon = document.getElementById(`wpfAuto${prefix}Icon`);
    if (icon) {
      icon.innerHTML = "";
      icon.className = "wpf-auto-next-icon wpf-loading";
    }

    const circle = document.getElementById(`wpfAuto${prefix}Circle`);
    if (circle) {
      circle.style.stroke = "#00e56a";
      circle.style.strokeDashoffset = "0";
    }

    if (!isNext) {
      autoPrevContainer?.classList.add("wpf-active");
    }
    setTimeout(() => {
      window.location.href = targetUrl;
    }, 600);
  }

  let scrollAccumulator = 0;
  let scrollDirection = null;
  const SCROLL_THRESHOLD = 1500;
  let decayTimer = null;
  let lastTimeHitBottom = 0;
  let lastTimeHitTop = 0;
  let wasAtBottom = false;
  let wasAtTop = false;

  function updateCircleProgress(direction, progress) {
    const prefix = direction === "previous" ? "Prev" : "Next";
    const circle = document.getElementById(`wpfAuto${prefix}Circle`);
    if (circle) {
      const circumference = 251.2;
      const offset = circumference * (1 - progress);
      circle.style.strokeDashoffset = offset;
    }

    if (direction === "previous") {
      autoPrevContainer?.classList.toggle("wpf-active", progress > 0);
    }
  }

  function resetScrollProgress() {
    scrollAccumulator = 0;
    if (scrollDirection) {
      updateCircleProgress(scrollDirection, 0);
    }
    scrollDirection = null;
  }

  function decayStep() {
    if (isNavigating || scrollAccumulator <= 0 || !scrollDirection) return;

    scrollAccumulator -= 60;
    if (scrollAccumulator < 0) {
      scrollAccumulator = 0;
    }

    const progress = scrollAccumulator / SCROLL_THRESHOLD;
    updateCircleProgress(scrollDirection, progress);

    if (scrollAccumulator > 0) {
      decayTimer = setTimeout(decayStep, 25);
    } else {
      scrollDirection = null;
    }
  }

  function resetDecayTimer() {
    if (decayTimer) {
      clearTimeout(decayTimer);
    }
    decayTimer = setTimeout(decayStep, 200);
  }

  function accumulateBoundaryScroll(direction, deltaY) {
    const isForward = direction === "previous" ? deltaY < 0 : deltaY > 0;
    if (scrollDirection && scrollDirection !== direction) {
      resetScrollProgress();
    }
    scrollDirection = direction;

    if (isForward) {
      scrollAccumulator = Math.min(
        scrollAccumulator + Math.abs(deltaY),
        SCROLL_THRESHOLD
      );
    } else {
      scrollAccumulator = Math.max(scrollAccumulator - Math.abs(deltaY), 0);
    }

    updateCircleProgress(direction, scrollAccumulator / SCROLL_THRESHOLD);
    if (scrollAccumulator >= SCROLL_THRESHOLD) {
      triggerEpisode(direction === "previous" ? "previous" : "next");
      return;
    }

    resetDecayTimer();
  }

  function handleWheelEvent(e) {
    if (!autoNextEnabled || isNavigating) return;

    const isAtTop = window.scrollY <= 5;
    if (isAtTop && prevEpUrl) {
      wasAtBottom = false;
      if (!wasAtTop) {
        wasAtTop = true;
        lastTimeHitTop = Date.now();
        resetScrollProgress();
        return;
      }

      if (Date.now() - lastTimeHitTop < 350) {
        resetScrollProgress();
        return;
      }

      accumulateBoundaryScroll("previous", e.deltaY);
      return;
    }

    wasAtTop = false;

    const isAtBottom = Math.ceil(window.innerHeight + window.scrollY) >= document.documentElement.scrollHeight - 200;
    if (!isAtBottom || !nextEpUrl) {
      wasAtBottom = false;
      if (scrollAccumulator > 0) {
        resetScrollProgress();
      }
      return;
    }

    const images = document.querySelectorAll(IMAGE_SELECTOR);
    if (images.length === 0) return;
    const lastImage = images[images.length - 1];
    const lastImageRect = lastImage.getBoundingClientRect();
    const hasPassedLastImage = lastImageRect.bottom <= window.innerHeight + 5;

    if (!hasPassedLastImage) {
      wasAtBottom = false;
      if (scrollAccumulator > 0) {
        resetScrollProgress();
      }
      return;
    }

    if (!wasAtBottom) {
      wasAtBottom = true;
      lastTimeHitBottom = Date.now();
      resetScrollProgress();
      return;
    }

    if (Date.now() - lastTimeHitBottom < 350) {
      resetScrollProgress();
      return;
    }

    accumulateBoundaryScroll("next", e.deltaY);
  }

  function handleAutoNextScroll() {
    if (!autoNextEnabled || isNavigating) return;

    if (!autoNextContainer) {
      initAutoNext();
    }
  }

  function removeAutoNext() {
    const container = document.getElementById("wpf-auto-next");
    if (container) {
      container.remove();
    }
    document.getElementById("wpf-auto-prev")?.remove();
    autoNextContainer = null;
    autoPrevContainer = null;
    nextEpUrl = null;
    prevEpUrl = null;
    isNavigating = false;
    wasAtTop = false;
    wasAtBottom = false;
    resetScrollProgress();
    if (decayTimer) {
      clearTimeout(decayTimer);
      decayTimer = null;
    }
    if (autoEpisodeRetryTimer) {
      clearTimeout(autoEpisodeRetryTimer);
      autoEpisodeRetryTimer = null;
    }
  }

  function applyAutoNextBehavior(enabled) {
    autoNextEnabled = enabled;

    if (!enabled) {
      removeAutoNext();
      window.removeEventListener("scroll", handleAutoNextScroll, { capture: true });
      window.removeEventListener("wheel", handleWheelEvent, { capture: true });
      return;
    }

    // The single setting controls navigation in both directions.
    nextEpUrl = null;
    prevEpUrl = null;
    initAutoNext();

    // Listen to scroll events (using capture: true to catch scrolls on custom scrollable containers)
    window.removeEventListener("scroll", handleAutoNextScroll, { capture: true });
    window.addEventListener("scroll", handleAutoNextScroll, { capture: true, passive: true });

    // Listen at both page boundaries (capture: true also supports Webtoon's viewer layout).
    window.removeEventListener("wheel", handleWheelEvent, { capture: true });
    window.addEventListener("wheel", handleWheelEvent, { capture: true, passive: true });
  }

  /**
   * Load settings from chrome.storage and apply them
   */
  function loadAndApply() {
    chrome.storage.local.get(DEFAULT_SETTINGS, (result) => {
      const settings = normalizeSettings(result);
      
      // 1. Apply styles immediately (document.documentElement is available at document_start)
      applyStyles(settings);

      // 2. Remove the temporary flash prevention style
      const tempStyle = document.getElementById(PREVENT_FLASH_STYLE_ID);
      if (tempStyle) {
        tempStyle.remove();
      }
      
      // 3. Initialize DOM behaviors once the DOM is ready
      if (window === window.top) {
        const initDOMBehaviors = () => {
          // Only run viewer-specific scripts on viewer pages
          const isViewerPage = window.location.pathname.includes("/viewer");
          if (isViewerPage) {
            if (settings.fitWidth) {
              startImageLoadingBridge();
            } else {
              stopImageLoadingBridge();
            }
            applyHideMouseBehavior(settings.hideMouse);
            applyAutoNextBehavior(settings.autoNext);
          } else {
            stopImageLoadingBridge();
            applyHideMouseBehavior(false);
            applyAutoNextBehavior(false);
          }
        };

        if (document.readyState === "loading") {
          document.addEventListener("DOMContentLoaded", initDOMBehaviors);
        } else {
          initDOMBehaviors();
        }
      }
    });
  }

  // Listen for setting changes from popup
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "local") {
      loadAndApply();
    }
  });

  // Initial apply on page load
  loadAndApply();

})();
