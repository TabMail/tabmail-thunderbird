/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Welcome wizard image error handling
 */

export function setupImageErrorHandlers() {
  // Handle all asset images - hide if they fail to load
  document.querySelectorAll(".asset-image").forEach(img => {
    img.addEventListener("error", () => {
      console.log("[Welcome] Asset not found:", img.src);
      img.style.display = "none";
    });

    img.addEventListener("load", () => {
      img.style.display = "block";
      // Hide the placeholder text when image loads
      const placeholder = img.parentElement?.querySelector(".placeholder-overlay, .placeholder-label");
      if (placeholder) {
        placeholder.style.display = "none";
      }
    });
  });

  // Handle logo separately
  const logoImg = document.getElementById("welcome-logo");
  if (logoImg) {
    logoImg.addEventListener("error", () => {
      console.log("[Welcome] Logo not found:", logoImg.src);
      logoImg.style.display = "none";
    });

    logoImg.addEventListener("load", () => {
      logoImg.style.display = "block";
    });
  }
}

