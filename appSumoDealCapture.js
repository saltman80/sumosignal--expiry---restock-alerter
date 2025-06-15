const SELECTORS = {
  // Used in findDealElements and MutationObserver to identify overall deal containers/elements
  dealIdentifier: '.appsumo-product-title-selector, .appsumo-deal-card-selector', // Placeholder from pseudocode
  // Used in extractDealData to find the title text within a dealElement
  titleInDeal: '.title-selector', // Placeholder from pseudocode, e.g., a specific class for product titles
  // Used in extractDealData to find the expiry date text
  expiryDate: '.deal-expiry-date-selector', // Placeholder from pseudocode
  // Used in enhanceDealElement to find a good place to insert the button, relative to a title/header
  // Prioritize titleInDeal if available, otherwise common header tags.
  buttonAnchor: '.title-selector, h1, h2, h3, h4', // Placeholder variation
};

// Function to identify AppSumo deal elements (product titles/cards)
function findDealElements() {
  return document.querySelectorAll(SELECTORS.dealIdentifier);
}

// Function to parse expiry date string (robust parsing needed)
function parseExpiryDate(dateString) {
  if (!dateString || typeof dateString !== 'string') {
    return null;
  }

  const cleanedDateString = dateString.trim().toLowerCase();

  // 1. Try common short relative dates
  const today = new Date();
  if (cleanedDateString.includes("tonight")) {
    const date = new Date(today);
    date.setHours(23, 59, 59, 999); // End of today
    return date.toISOString();
  }
  if (cleanedDateString.includes("tomorrow")) {
    const date = new Date(today);
    date.setDate(date.getDate() + 1);
    date.setHours(23, 59, 59, 999); // End of tomorrow
    return date.toISOString();
  }

  // 2. Try detailed relative dates: "ends in X days", "X hours left", etc.
  let relativeDateMatch = cleanedDateString.match(/(?:ends in|expires in|in)\s*(\d+)\s*(day|hour)s?/i);
  if (!relativeDateMatch) {
    relativeDateMatch = cleanedDateString.match(/(\d+)\s*(day|hour)s?\s*left/i);
  }

  if (relativeDateMatch) {
    const value = parseInt(relativeDateMatch[1], 10);
    const unit = relativeDateMatch[2].toLowerCase();
    const date = new Date();

    if (unit === 'day') {
      date.setDate(date.getDate() + value);
      date.setHours(23, 59, 59, 999); // Set to end of day
    } else if (unit === 'hour') {
      date.setHours(date.getHours() + value);
    }
    return date.toISOString();
  }

  // 3. Try to parse absolute dates
  // Clean common prefixes and time parts for better parsing of the date itself
  let parsableString = cleanedDateString
    .replace(/^(expires on|ends on|deal ends on|ends at|expires at)\s*/i, '')
    .replace(/\s*at\s*\d{1,2}:\d{2}\s*(am|pm)?(\s*[a-z]{2,})?(\s*[a-z]{2,})?$/i, ''); // Remove time component, allow for timezone abbreviation

  // Helper for month name to number
  const monthMap = {
    jan: 0, jan:0, january: 0, feb: 1, february: 1, mar: 2, march: 2, apr: 3, april: 3,
    may: 4, jun: 5, june: 5, jul: 6, july: 6, aug: 7, august: 7, sep: 8, september: 8,
    oct: 9, october: 9, nov: 10, november: 10, dec: 11, december: 11
  };

  // Try specific formats before generic new Date()
  // Format: "Month Day, Year" or "Month Day Year" e.g., "Oct 25, 2024" or "October 25 2024"
  let match = parsableString.match(/([a-z]+)\.?\s+(\d{1,2}),?\s+(\d{4})/i);
  if (match) {
    const month = monthMap[match[1].toLowerCase()];
    const day = parseInt(match[2], 10);
    const year = parseInt(match[3], 10);
    if (month !== undefined && !isNaN(day) && !isNaN(year)) {
      const d = new Date(Date.UTC(year, month, day)); // Use UTC to avoid timezone shifts during construction
      return d.toISOString();
    }
  }

  // Format: "Day Month Year" e.g., "25 Oct 2024"
  match = parsableString.match(/(\d{1,2})\s+([a-z]+)\.?\s+(\d{4})/i);
  if (match) {
    const day = parseInt(match[1], 10);
    const month = monthMap[match[2].toLowerCase()];
    const year = parseInt(match[3], 10);
    if (month !== undefined && !isNaN(day) && !isNaN(year)) {
      const d = new Date(Date.UTC(year, month, day));
      return d.toISOString();
    }
  }
  
  // Fallback: Try to parse the cleaned string directly with new Date()
  // This is less reliable for ambiguous formats like MM/DD/YYYY vs DD/MM/YYYY
  // but good for ISO-like strings or unambiguous textual dates.
  const parsedDate = new Date(parsableString);
  if (!isNaN(parsedDate.getTime())) {
    // If the year is very old (e.g. < 2000), it might be a misinterpretation of DD/MM/YY vs MM/DD/YY
    // For now, accept what new Date() provides.
    // Ensure it's not a date far in the past unless it's reasonable (e.g. parsing '1999' as year)
    // A simple check could be if year is < currentYear - N or > currentYear + M
    return parsedDate.toISOString();
  }

  // console.warn(`SumoSignal: Could not parse date string: "${dateString}" after all attempts.`);
  return null; // Return null if parsing fails
}

// Function to extract deal data from an element
function extractDealData(element) {
  const titleElement = element.querySelector(SELECTORS.titleInDeal);
  const title = titleElement ? titleElement.textContent.trim() : null;

  // URL: element's href if it's an <a> tag, or closest <a> parent's href, or current page URL as fallback
  let url = element.href || element.closest('a')?.href;
  if (!url && (element.tagName === 'A' || element.querySelector('a'))) { // Check if element itself or a child is an anchor
    url = (element.tagName === 'A' ? element.href : element.querySelector('a').href);
  }
  if (!url) {
    url = window.location.href; // Fallback to current page URL
  }


  let expiryDate = null;
  // Try to find expiry date within the current deal element first, then fall back to a page-global one.
  const expiryElement = element.querySelector(SELECTORS.expiryDate) || document.querySelector(SELECTORS.expiryDate);

  if (expiryElement) {
    const expiryText = expiryElement.textContent ? expiryElement.textContent.trim() : null;
    if (expiryText) {
      expiryDate = parseExpiryDate(expiryText);
    }
  }
  return { title, url, expiryDate };
}

// Function to inject a 'Save' button
function enhanceDealElement(dealElement) {
  // Prevent adding multiple buttons to the same element
  if (dealElement.querySelector('.sumosignal-save-button')) {
    return;
  }

  const saveButton = document.createElement('button');
  saveButton.textContent = 'Save to SumoSignal';
  saveButton.classList.add('sumosignal-save-button');
  // Styling for this button should be handled by 'injecteduistyles.css' (as per project plan)

  saveButton.onclick = (e) => {
    e.stopPropagation(); // Prevent click from triggering parent link navigation
    e.preventDefault();  // Prevent default button action

    const data = extractDealData(dealElement);

    if (data.title && data.url) {
      saveButton.textContent = 'Saving...';
      saveButton.disabled = true;

      chrome.runtime.sendMessage({ action: 'saveDeal', data }, (response) => {
        if (chrome.runtime.lastError) {
          console.error('SumoSignal: Error saving deal:', chrome.runtime.lastError.message);
          saveButton.textContent = 'Error!';
          setTimeout(() => {
            saveButton.textContent = 'Save to SumoSignal';
            saveButton.disabled = false;
          }, 2000);
        } else {
          console.log('SumoSignal: Deal save response:', response);
          if (response && response.success) {
            saveButton.textContent = 'Saved!';
            // Button remains disabled and shows "Saved!" to indicate success and prevent re-saving.
          } else {
            const message = response && response.message ? response.message : 'Failed!';
            saveButton.textContent = message;
            setTimeout(() => {
              saveButton.textContent = 'Save to SumoSignal';
              saveButton.disabled = false;
            }, 3000);
          }
        }
      });
    } else {
      if (!data.title) {
        console.warn('SumoSignal: Could not extract title for deal element:', dealElement);
        saveButton.textContent = 'Cannot Save: No Title';
        saveButton.disabled = true; // Permanently disable if title is missing
      } else if (!data.url) { // Less likely due to fallback, but good to check
        console.warn('SumoSignal: Could not extract URL for deal element:', dealElement);
        saveButton.textContent = 'Cannot Save: No URL';
        saveButton.disabled = true; // Permanently disable
      } else {
        saveButton.textContent = 'Data Error'; // Generic error
        setTimeout(() => {
          saveButton.textContent = 'Save to SumoSignal';
          // Decide if button should be re-enabled. For generic 'Data Error', maybe re-enable.
          saveButton.disabled = false;
        }, 2000);
      }
    }
  };

  // Attempt to insert the button strategically.
  const anchorElement = dealElement.querySelector(SELECTORS.buttonAnchor);
  if (anchorElement && anchorElement.parentElement) {
    // Insert button as a sibling, after the anchor element.
    anchorElement.parentElement.insertBefore(saveButton, anchorElement.nextSibling);
  } else {
    // Fallback: append to the deal element itself.
    dealElement.appendChild(saveButton);
  }
}

// Main execution logic for content script
function main() {
  const processFoundDealElements = (elements) => {
    elements.forEach(enhanceDealElement);
  };

  // Initial processing of deals already on the page
  processFoundDealElements(findDealElements());

  // Observer for dynamically loaded content
  const observer = new MutationObserver((mutationsList) => {
    for (const mutation of mutationsList) {
      if (mutation.type === 'childList' && mutation.addedNodes.length > 0) {
        mutation.addedNodes.forEach(node => {
          if (node.nodeType === Node.ELEMENT_NODE) {
            // Check if the added node itself is a deal element
            if (node.matches && node.matches(SELECTORS.dealIdentifier)) {
              enhanceDealElement(node);
            }
            // Check if the added node contains new deal elements
            // Using querySelectorAll on the node itself
            const newDealsInNode = node.querySelectorAll(SELECTORS.dealIdentifier);
            if (newDealsInNode.length > 0) {
              processFoundDealElements(newDealsInNode);
            }
          }
        });
      }
    }
  });

  observer.observe(document.body, { childList: true, subtree: true });
}

// Ensure script runs after the DOM is fully loaded
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', main);
} else {
  // DOM is already loaded
  main();
}