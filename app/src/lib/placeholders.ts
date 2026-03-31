const svg = `
<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="800" viewBox="0 0 1200 800" fill="none">
  <rect width="1200" height="800" fill="#F3F4F6"/>
  <rect x="70" y="70" width="1060" height="660" rx="28" fill="#FFFFFF" stroke="#D1D5DB" stroke-width="8" stroke-dasharray="18 14"/>
  <circle cx="600" cy="320" r="86" fill="#E5E7EB"/>
  <path d="M540 420h120c26 0 48 22 48 48v0H492v0c0-26 22-48 48-48Z" fill="#E5E7EB"/>
  <text x="600" y="585" text-anchor="middle" fill="#111827" font-size="64" font-family="Arial, Helvetica, sans-serif" font-weight="700">NO PHOTO</text>
  <text x="600" y="645" text-anchor="middle" fill="#6B7280" font-size="28" font-family="Arial, Helvetica, sans-serif">画像が登録されていない店舗です</text>
</svg>`;

export const noPhotoDataUrl = `data:image/svg+xml;charset=UTF-8,${encodeURIComponent(svg)}`;
