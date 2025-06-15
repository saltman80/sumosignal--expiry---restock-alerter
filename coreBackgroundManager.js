const EXPIRY_ALARM_NAME = 'expiryCheckAlarm';
const RESTOCK_ALARM_NAME = 'restockCheckAlarm';

// Initialize services
const storage = new StorageManager(); // Assumed to be defined elsewhere, with methods like getSettings(), addDeal(), etc.
const notifier = new NotificationService(); // Assumed to be defined elsewhere
const csvExporter = new CsvExporterService(); // Assumed to be defined elsewhere
// DateTimeHelper and StringSimilarityScorer are assumed to be available, e.g., globally or imported if using modules.
// Example:
// import { DateTimeHelper } from './shared_utilities.js';
// import { StringSimilarityScorer } from './shared_utilities.js';


// --- Configuration Management ---
// Default configuration values. In a real application, these would ideally be
// loaded from an appconfig.js file and then overridden by user settings from chrome.storage.
// For this fix, we define them here and assume storage.getSettings() will provide overrides.
const DEFAULT_APP_CONFIG = {
  expiryCheckPeriodInMinutes: 60,  // Default: Check hourly
  restockCheckPeriodInMinutes: 240, // Default: Check every 4 hours
  restockApiEndpoint: 'https://api.appsumo.com/v1/deals/active', // Placeholder: Actual AppSumo API or scraping source for current deals
  expiryWarningLeadTimeHours: 48, // Default: Warn 48 hours before expiry
  similarityThreshold: 0.8, // Default for string similarity in restock checks
};

let currentConfig = { ...DEFAULT_APP_CONFIG }; // Initialize with defaults

// Function to load configuration from storage and apply it.
// This would typically be more robust, potentially involving appconfig.js for initial defaults.
async function loadAndApplyConfig() {
  try {
    // Attempt to load user-defined settings from storage.
    // StorageManager should have a method like getSettings().
    const userSettings = await storage.getSettings();
    if (userSettings && Object.keys(userSettings).length > 0) {
      currentConfig = { ...DEFAULT_APP_CONFIG, ...userSettings };
      console.log('Configuration loaded from storage:', currentConfig);
    } else {
      currentConfig = { ...DEFAULT_APP_CONFIG }; // Fallback to compiled defaults if no user settings
      console.log('No user settings found or settings empty, using default configuration:', currentConfig);
    }
  } catch (error) {
    console.warn('Error loading configuration from storage, using default configuration:', error);
    currentConfig = { ...DEFAULT_APP_CONFIG }; // Fallback to defaults on error
  }

  // (Re-)Create alarms with the current configuration values.
  // chrome.alarms.create will update an existing alarm if the name matches.
  chrome.alarms.create(EXPIRY_ALARM_NAME, { periodInMinutes: currentConfig.expiryCheckPeriodInMinutes });
  chrome.alarms.create(RESTOCK_ALARM_NAME, { periodInMinutes: currentConfig.restockCheckPeriodInMinutes });
  console.log(`Alarms scheduled: Expiry every ${currentConfig.expiryCheckPeriodInMinutes}m, Restock every ${currentConfig.restockCheckPeriodInMinutes}m.`);
}


// Event listener for extension installation/update
chrome.runtime.onInstalled.addListener(async (details) => {
  await loadAndApplyConfig(); // Load config and set up/update alarms

  if (details.reason === 'install') {
    console.log('SumoSignal installed. Alarms set up with initial/default configuration.');
    // onboardingmanager.js might be triggered here if part of the project
    // Example: chrome.runtime.openOptionsPage(); or a custom welcome notification
  } else if (details.reason === 'update') {
    console.log('SumoSignal updated. Alarms re-verified/updated with current configuration.');
  }
  // Optionally, perform initial checks immediately after setup
  // await performExpiryChecks();
  // await performRestockChecks();
});

// Listener for alarm triggers
chrome.alarms.onAlarm.addListener(async (alarm) => {
  console.log(`Alarm triggered: ${alarm.name} at ${new Date().toLocaleTimeString()}`);
  // Reload config before running checks, in case settings changed since last alarm schedule.
  await loadAndApplyConfig();

  if (alarm.name === EXPIRY_ALARM_NAME) {
    await performExpiryChecks();
  } else if (alarm.name === RESTOCK_ALARM_NAME) {
    await performRestockChecks();
  }
});

// Listener for messages from content scripts or UI
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  (async () => {
    let result;
    try {
      switch (request.action) {
        case 'saveDeal':
          result = await handleSaveDeal(request.data);
          break;
        case 'markAsMissed':
          result = await handleMarkAsMissed(request.dealId);
          break;
        case 'exportCsv':
          result = await handleExportCsv();
          break;
        case 'getWatchlist':
          const watchingDeals = await storage.getDealsByStatus('watching');
          result = { success: true, data: watchingDeals };
          break;
        case 'getAllDeals':
          const allDeals = await storage.getAllDeals();
          result = { success: true, data: allDeals };
          break;
        case 'deleteDeal':
          result = await handleDeleteDeal(request.dealId);
          break;
        case 'updateDealNotes':
          result = await handleUpdateDealNotes(request.dealId, request.notes);
          break;
        case 'refreshConfig': // Action to explicitly reload config (e.g., after options save)
            await loadAndApplyConfig();
            result = { success: true, message: 'Configuration reloaded and alarms updated.' };
            break;
        default:
          result = { success: false, message: `Unknown action: ${request.action}` };
      }
    } catch (error) {
      console.error(`Error processing message action ${request.action}:`, error);
      result = { success: false, message: error.message || 'An unexpected error occurred in background script.' };
    }
    sendResponse(result);
  })();
  return true; // Indicates asynchronous response
});

// Listener for notification clicks
chrome.notifications.onClicked.addListener(async (notificationId) => {
  console.log(`Notification clicked: ${notificationId}`);
  const dealUrl = await notifier.getDealUrlFromNotificationId(notificationId);

  if (dealUrl) {
    chrome.tabs.create({ url: dealUrl });
  } else {
    console.warn(`No URL found for notificationId: ${notificationId}`);
  }

  chrome.notifications.clear(notificationId, (wasCleared) => {
    if (wasCleared) {
      console.log(`Notification ${notificationId} cleared.`);
    } else {
      console.warn(`Notification ${notificationId} could not be cleared.`);
    }
  });
});

async function handleSaveDeal(dealData) {
  if (!dealData || !dealData.id || !dealData.title || !dealData.url) {
    throw new Error('Invalid deal data: id, title, and url are required.');
  }
  const savedDate = new Date().toISOString();
  const dealToSave = {
    ...dealData,
    dateSaved: savedDate,
    status: 'watching'
  };

  await storage.addDeal(dealToSave);
  notifier.showSaveConfirmation(dealToSave.title);
  console.log(`Deal saved: ${dealToSave.title} (ID: ${dealToSave.id})`);
  return { success: true, message: 'Deal saved successfully!', deal: dealToSave };
}

async function handleMarkAsMissed(dealId) {
  if (!dealId) throw new Error('Deal ID is required to mark as missed.');

  const deal = await storage.getDealById(dealId);
  if (!deal) throw new Error(`Deal with ID ${dealId} not found.`);

  await storage.updateDealStatus(dealId, 'missed');
  console.log(`Deal marked as missed: ${deal.title} (ID: ${dealId})`);
  return { success: true, message: `Deal "${deal.title}" marked as missed.` };
}

async function handleDeleteDeal(dealId) {
  if (!dealId) throw new Error('Deal ID is required to delete a deal.');

  await storage.deleteDeal(dealId);
  console.log(`Deal deleted: (ID: ${dealId})`);
  return { success: true, message: 'Deal deleted successfully.' };
}

async function handleUpdateDealNotes(dealId, notes) {
  if (!dealId) throw new Error('Deal ID is required to update notes.');
  if (typeof notes !== 'string') throw new Error('Notes must be a string.');

  await storage.updateDeal(dealId, { notes });
  console.log(`Notes updated for deal ID: ${dealId}`);
  return { success: true, message: 'Deal notes updated.' };
}

async function performExpiryChecks() {
  console.log('Performing expiry checks...');
  const watchingDeals = await storage.getDealsByStatus('watching');
  const now = new Date();
  // Use configured lead time from currentConfig
  const leadTimeInMs = currentConfig.expiryWarningLeadTimeHours * 60 * 60 * 1000;

  for (const deal of watchingDeals) {
    if (deal.expiryDate) {
      try {
        const expiry = new Date(deal.expiryDate);
        if (isNaN(expiry.getTime())) {
          console.warn(`Invalid expiry date for deal ${deal.title} (ID: ${deal.id}): ${deal.expiryDate}. Skipping.`);
          continue;
        }

        if (expiry.getTime() < now.getTime()) {
          console.log(`Deal ${deal.title} (ID: ${deal.id}) has expired. Marking as missed.`);
          await storage.updateDealStatus(deal.id, 'missed');
        } else if (typeof DateTimeHelper !== 'undefined' && DateTimeHelper.isImminent(now, expiry, leadTimeInMs)) {
          console.log(`Deal ${deal.title} (ID: ${deal.id}) is expiring soon.`);
          notifier.showExpiryWarning(deal);
        } else if (typeof DateTimeHelper === 'undefined') {
            console.warn("DateTimeHelper not available, cannot perform isImminent check accurately.");
            // Fallback: check if expiry is within the lead time (less precise without proper date math helper)
            if ((expiry.getTime() - now.getTime()) < leadTimeInMs) {
                console.log(`Deal ${deal.title} (ID: ${deal.id}) is expiring soon (fallback check).`);
                notifier.showExpiryWarning(deal);
            }
        }
      } catch (error) {
        console.error(`Error processing expiry for deal ${deal.title} (ID: ${deal.id}):`, error);
      }
    }
  }
  console.log('Expiry checks completed.');
}

// Helper function to check if a deal page seems active
async function checkDealPageActive(dealUrl) {
  if (!dealUrl) return false;
  try {
    const response = await fetch(dealUrl, { method: 'GET', redirect: 'follow', cache: 'no-store' });
    // A simple check: if the page is accessible (2xx status).
    // More sophisticated checks would involve parsing content to ensure it's not a "deal ended" page or 404.
    if (response.ok) {
        // const pageContent = await response.text();
        // if (pageContent.toLowerCase().includes("deal has ended") || pageContent.toLowerCase().includes("not available")) {
        //   return false; // Page indicates deal is not active
        // }
        return true; // Page is accessible
    }
    console.warn(`Deal page ${dealUrl} returned status ${response.status}. Marked as not active.`);
    return false;
  } catch (error) {
    console.error(`Error fetching deal page ${dealUrl} for activity check:`, error);
    return false; // Network error or other issue implies not active
  }
}

// Helper function to fetch current deal listings from a server/API
async function fetchCurrentAppSumoDealsFromServer(apiEndpoint) {
  if (!apiEndpoint) {
    console.warn('Restock API endpoint not configured. Cannot fetch current deals.');
    return [];
  }
  try {
    const response = await fetch(apiEndpoint, {
      method: 'GET',
      headers: { 'Accept': 'application/json' }, // Assuming a JSON API
      cache: 'no-store' // Ensure fresh data
    });
    if (!response.ok) {
      console.error(`Error fetching current deals from ${apiEndpoint}: ${response.status} ${response.statusText}`);
      return [];
    }
    const data = await response.json();
    // Assuming the API returns an array of deal objects, each with at least 'title' and 'url'
    // e.g., { deals: [{id, title, url,...}] } or directly [{id, title, url,...}]
    return data.deals || (Array.isArray(data) ? data : []);
  } catch (error) {
    console.error(`Error fetching or parsing current deals from ${apiEndpoint}:`, error);
    return [];
  }
}

async function performRestockChecks() {
  console.log('Performing restock checks...');
  const missedDeals = await storage.getDealsByStatus('missed');

  for (const deal of missedDeals) {
    try {
      // 1. Check if the original deal URL is active again
      if (deal.url) {
        const isOriginalUrlActive = await checkDealPageActive(deal.url);
        if (isOriginalUrlActive) {
          console.log(`Deal ${deal.title} (ID: ${deal.id}) appears active again at original URL.`);
          // Notify the user about the restock at the original URL
          notifier.showRestockAlert(deal, {
            ...deal, // Use original deal data
            restockType: 'original_url_active',
            notes: `The original page for "${deal.title}" seems to be active again.`
          });
          // Move the deal back to 'watching' status
          await storage.updateDealStatus(deal.id, 'watching');
          console.log(`Deal ${deal.title} (ID: ${deal.id}) moved back to watching list.`);
          continue; // Processed this deal, move to the next one
        }
      }

      // 2. Fetch current AppSumo listings and check for similar deals (if original URL not active)
      const currentAppSumoDeals = await fetchCurrentAppSumoDealsFromServer(currentConfig.restockApiEndpoint);
      if (currentAppSumoDeals.length > 0) {
        for (const currentDeal of currentAppSumoDeals) {
          // Ensure both deals have titles for comparison
          if (deal.title && currentDeal.title && currentDeal.url) {
            let isSimilar;
            if (typeof StringSimilarityScorer !== 'undefined') {
                 const scorer = new StringSimilarityScorer(); // Instantiate if available
                 isSimilar = scorer.isSimilar(deal.title, currentDeal.title, currentConfig.similarityThreshold);
            } else {
                // Fallback basic similarity: case-insensitive equality or simple substring check.
                // This is a very basic fallback.
                isSimilar = deal.title.toLowerCase() === currentDeal.title.toLowerCase() ||
                            deal.title.toLowerCase().includes(currentDeal.title.toLowerCase()) ||
                            currentDeal.title.toLowerCase().includes(deal.title.toLowerCase());
                if (isSimilar) console.warn("StringSimilarityScorer not available, using basic title match for restock check.");
            }

            if (isSimilar) {
              console.log(`Potential restock for (missed deal) "${deal.title}" (ID: ${deal.id}) found: New listing "${currentDeal.title}"`);
              // Notify user about a similar new listing
              notifier.showRestockAlert(deal, { // Pass original deal for context in notification
                ...currentDeal, // Provide new deal's data for the notification content
                originalMissedDealTitle: deal.title,
                originalMissedDealId: deal.id,
                restockType: 'similar_new_listing',
                notes: `A similar deal titled "${currentDeal.title}" is now available. Your missed deal was "${deal.title}".`
              });
              // Optionally, you could mark the old deal with a special status like 'found_similar'
              // or leave it as 'missed' and let the user decide. For now, just notify.
              break; // Found a similar deal, stop checking other current deals for this missed deal
            }
          }
        }
      }
    } catch (error) {
      console.error(`Error performing restock check for deal ${deal.title} (ID: ${deal.id}):`, error);
    }
  }
  console.log('Restock checks completed.');
}


async function handleExportCsv() {
  console.log('Handling CSV export request...');
  const allDeals = await storage.getAllDeals();

  if (!allDeals || allDeals.length === 0) {
    console.log('No deals to export.');
    return { success: true, message: 'No deals available to export.' };
  }

  const csvString = csvExporter.generateCsv(allDeals);
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const filename = `sumosignal_watchlist_${timestamp}.csv`;

  try {
    const downloadId = await new Promise((resolve, reject) => {
      chrome.downloads.download({
        url: 'data:text/csv;charset=utf-8,' + encodeURIComponent(csvString),
        filename: filename,
        saveAs: true
      }, (id) => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
        } else if (id === undefined) {
          reject(new Error('Download initiation failed: No download ID. Download might be blocked.'));
        } else {
          resolve(id);
        }
      });
    });
    console.log(`CSV export initiated. DownloadId: ${downloadId}`);
    return { success: true, message: 'CSV export initiated.' };
  } catch (error) {
    console.error('CSV Download failed:', error.message);
    return { success: false, message: `CSV export failed: ${error.message}` };
  }
}