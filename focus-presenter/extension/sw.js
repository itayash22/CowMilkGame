// Toolbar icon opens the presenter in its own tab.
chrome.action.onClicked.addListener(() => {
  chrome.tabs.create({ url: 'index.html' });
});
