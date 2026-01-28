// Migration notice popup script
import { injectPaletteIntoDocument } from "../theme/palette/palette.js";

// Inject TabMail palette CSS
injectPaletteIntoDocument(document).then(() => {
  console.log("[MigrationNotice] Palette CSS injected");
}).catch((e) => {
  console.warn("[MigrationNotice] Failed to inject palette CSS:", e);
});

document.addEventListener('DOMContentLoaded', () => {
  // Check URL params
  const urlParams = new URLSearchParams(window.location.search);
  const type = urlParams.get('type');
  const fromVersion = urlParams.get('from');
  const toVersion = urlParams.get('to');
  
  const titleEl = document.querySelector('h1');
  const container = document.querySelector('.container');

  if (type === 'update') {
    titleEl.textContent = "TabMail search component updated. Please restart Thunderbird for full compatibility.";
    
    // Add restart button
    const btnContainer = document.createElement('div');
    btnContainer.style.marginTop = '20px';
    
    const restartBtn = document.createElement('button');
    restartBtn.textContent = 'Restart Now';
    restartBtn.style.cssText = `
      padding: 10px 24px;
      font-size: 14px;
      font-weight: 500;
      background: var(--in-content-accent-color);
      color: white;
      border: none;
      border-radius: 4px;
      cursor: pointer;
      margin-right: 12px;
    `;
    restartBtn.addEventListener('click', async (e) => {
      e.stopPropagation();
      try {
        if (browser.tmUpdates?.restartThunderbird) {
          await browser.tmUpdates.restartThunderbird();
        } else {
          alert('Please restart Thunderbird manually.');
          window.close();
        }
      } catch (err) {
        console.warn('Failed to restart:', err);
        alert('Please restart Thunderbird manually.');
        window.close();
      }
    });
    
    const laterBtn = document.createElement('button');
    laterBtn.textContent = 'Later';
    laterBtn.style.cssText = `
      padding: 10px 24px;
      font-size: 14px;
      font-weight: 500;
      background: transparent;
      color: var(--in-content-accent-color);
      border: 1px solid var(--in-content-accent-color);
      border-radius: 4px;
      cursor: pointer;
    `;
    laterBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      window.close();
    });
    
    btnContainer.appendChild(restartBtn);
    btnContainer.appendChild(laterBtn);
    container.appendChild(btnContainer);
    
    // Don't auto-close on click for update type
    return;
  } else if (type === 'migration') {
    titleEl.textContent = "TabMail search is now set to auto-update after next Thunderbird restart.";
  } else if (type === 'reindex') {
    // Reindex required due to minor version upgrade
    titleEl.textContent = "Search Engine Upgraded";
    
    // Add more detailed message
    const detailsP = document.createElement('p');
    detailsP.style.marginTop = '12px';
    detailsP.innerHTML = `
      The search engine has been upgraded from <strong>v${fromVersion || '?'}</strong> to <strong>v${toVersion || '?'}</strong> 
      with improved search quality (stemming, synonyms).
      <br><br>
      Please go to <strong>Settings → Full Reindex</strong> to rebuild your search index.
    `;
    
    // Insert after title
    titleEl.insertAdjacentElement('afterend', detailsP);
    
    // Add a button to open settings
    const btnContainer = document.createElement('div');
    btnContainer.style.marginTop = '20px';
    
    const settingsBtn = document.createElement('button');
    settingsBtn.textContent = 'Open Settings';
    settingsBtn.style.cssText = `
      padding: 10px 24px;
      font-size: 14px;
      font-weight: 500;
      background: var(--in-content-accent-color);
      color: var(--in-content-button-color);
      border: none;
      border-radius: 4px;
      cursor: pointer;
      margin-right: 12px;
    `;
    settingsBtn.addEventListener('click', async (e) => {
      e.stopPropagation();
      try {
        await browser.runtime.openOptionsPage();
      } catch (err) {
        console.warn('Failed to open settings:', err);
      }
      window.close();
    });
    
    const dismissBtn = document.createElement('button');
    dismissBtn.textContent = 'Later';
    dismissBtn.style.cssText = `
      padding: 10px 24px;
      font-size: 14px;
      font-weight: 500;
      background: transparent;
      color: var(--in-content-accent-color);
      border: 1px solid var(--in-content-accent-color);
      border-radius: 4px;
      cursor: pointer;
    `;
    dismissBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      window.close();
    });
    
    btnContainer.appendChild(settingsBtn);
    btnContainer.appendChild(dismissBtn);
    container.appendChild(btnContainer);
    
    // Don't auto-close on click for reindex type
    return;
  }

  // Allow click anywhere to dismiss (for other types)
  document.addEventListener('click', () => {
    window.close();
  });
});
