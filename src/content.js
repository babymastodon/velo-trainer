// content.js
// Runs as a classic content script (not a module) and dynamically imports scrapers.js as an ES module.

(async () => {
  let parseTrainerRoadPage = null;
  let parseTrainerDayPage = null;
  let parseWhatsOnZwiftPage = null;

  // Try to load the scrapers module dynamically
  try {
    const scrapersUrl = chrome.runtime.getURL("scrapers.js");
    const mod = await import(scrapersUrl);
    parseTrainerRoadPage = mod.parseTrainerRoadPage;
    parseTrainerDayPage = mod.parseTrainerDayPage;
    parseWhatsOnZwiftPage = mod.parseWhatsOnZwiftPage;
  } catch (err) {
    console.error(
      "[VeloDrive][Content] Failed to load scrapers.js module:",
      err
    );
  }

  // ---------------- Site detection ----------------

  function getSiteType() {
    const host = location.host || "";
    if (host.includes("trainerroad.com")) return "trainerroad";
    if (host.includes("trainerday.com")) return "trainerday";
    if (host.includes("whatsonzwift.com")) return "whatsonzwift";
    return null;
  }

  /**
   * @typedef ScrapeResult
   * @property {boolean} success
   * @property {string} source
   * @property {string} sourceURL
   * @property {string} workoutTitle
   * @property {Array<[number, number, number]>} rawSegments
   * @property {string} description
   * @property {string} [error]
   * @property {string} [errorDebug]
   */

  // ---------------- Main scrape dispatcher ----------------

  async function handleScrapeRequest() {
    const site = getSiteType();

    /** @type {ScrapeResult} */
    let result = {
      success: false,
      source: site || "Unknown",
      sourceURL: window.location.href,
      workoutTitle: "",
      rawSegments: [],
      description: "",
      error: "",
    };

    // If the module didn’t load, bail with a friendly error
    if (
      !parseTrainerRoadPage ||
      !parseTrainerDayPage ||
      !parseWhatsOnZwiftPage
    ) {
      result.error =
        "VeloDrive couldn’t load its workout parser on this page. Try reloading the tab and running the import again.";
      result.success = false;

      if (chrome.runtime && chrome.runtime.sendMessage) {
        chrome.runtime.sendMessage({
          type: "VD_SCRAPE_RESULT",
          payload: result,
        });
      }
      return;
    }

    try {
      /** @type {import('./zwo.js').CanonicalWorkout | null} */
      let workout = null;
      /** @type {string | null} */
      let friendlyError = null;

      if (site === "trainerroad") {
        [workout, friendlyError] = await parseTrainerRoadPage();
      } else if (site === "trainerday") {
        [workout, friendlyError] = await parseTrainerDayPage();
      } else if (site === "whatsonzwift") {
        [workout, friendlyError] = await parseWhatsOnZwiftPage();
      } else {
        friendlyError =
          "VeloDrive doesn’t recognize this site yet. Try opening a workout on TrainerRoad, TrainerDay, or WhatsOnZwift.";
      }

      if (workout) {
        const {
          source,
          sourceURL,
          workoutTitle,
          rawSegments,
          description,
        } = workout;

        const hasSegments =
          Array.isArray(rawSegments) && rawSegments.length > 0;
        const hasTitle = !!(workoutTitle && workoutTitle.trim());

        result = {
          success: hasSegments && hasTitle,
          source: source || site || "Unknown",
          sourceURL: sourceURL || window.location.href,
          workoutTitle: workoutTitle || "",
          rawSegments: hasSegments ? rawSegments : [],
          description: description || "",
          error:
            hasSegments && hasTitle
              ? ""
              : friendlyError ||
              "VeloDrive could not find any workout data on this page.",
        };
      } else {
        // No canonical workout returned → use friendly error
        result.error =
          friendlyError ||
          "VeloDrive could not scrape this workout from this page.";
        result.success = false;
      }
    } catch (err) {
      const msg = String(err && err.message ? err.message : err);
      console.warn("[VeloDrive][Content] scrape error:", err);
      result.error =
        "VeloDrive ran into an unexpected error while reading this workout. Try reloading the page and trying again.";
      result.success = false;
      result.errorDebug = msg; // optional, for background debugging
    }

    // Send result to background.js for persistence + follow-up behavior
    if (chrome.runtime && chrome.runtime.sendMessage) {
      chrome.runtime.sendMessage({
        type: "VD_SCRAPE_RESULT",
        payload: result,
      });
    }
  }

  // ---------------- Message handling ----------------

  if (chrome.runtime && chrome.runtime.onMessage) {
    chrome.runtime.onMessage.addListener((msg, _sender, _sendResponse) => {
      if (!msg || typeof msg !== "object") return;

      if (msg.type === "VD_SCRAPE_WORKOUT") {
        handleScrapeRequest();
        return;
      }

      if (msg.type === "VD_SCRAPE_FAILED_PROMPT") {
        const {error, source} = msg;
        let text = "VeloDrive could not scrape this workout.";
        if (source) {
          text = `VeloDrive could not scrape this workout from ${source}.`;
        }
        if (error) {
          text += `\n\nError: ${error}`;
        }
        text += "\n\nDo you still want to open VeloDrive?";

        let openOptions = true;
        try {
          openOptions = window.confirm(text);
        } catch {
          // If confirm fails for some reason, default to opening.
          openOptions = true;
        }

        _sendResponse({openOptions});
        return true; // indicate we used sendResponse
      }
    });
  }
})();

