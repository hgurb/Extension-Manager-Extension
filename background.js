chrome.action.onClicked.addListener(async () => {
  try {
    const url = chrome.runtime.getURL('manager.html');
    const tabs = await chrome.tabs.query({ url });
    if (tabs.length) {
      await chrome.tabs.update(tabs[0].id, { active: true });
      await chrome.windows.update(tabs[0].windowId, { focused: true });
    } else {
      await chrome.tabs.create({ url });
    }
  } catch (error) {
    console.error('Could not open Extension Manager:', error);
  }
});
