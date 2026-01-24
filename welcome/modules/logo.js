/**
 * Welcome wizard logo setup
 */

export function setupLogo() {
  const logoImg = document.getElementById("welcome-logo");
  if (!logoImg) return;

  const updateLogo = () => {
    const isDark = window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches;
    logoImg.src = isDark ? "assets/logo-dark.svg" : "assets/logo-light.svg";
    console.log("[Welcome] Logo set for", isDark ? "dark" : "light", "mode");
  };

  // Initial set
  updateLogo();

  // Listen for color scheme changes
  if (window.matchMedia) {
    window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", updateLogo);
  }
}

