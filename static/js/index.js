const sceneControls = document.querySelector('.scene-controls');
const sceneImage = document.querySelector('#scene-image');
const sceneCaption = document.querySelector('#scene-caption');

sceneControls.hidden = false;
sceneControls.addEventListener('click', (event) => {
  const selected = event.target.closest('button');
  if (!selected) return;

  if (selected.getAttribute('aria-pressed') === 'true') return;
  sceneImage.classList.remove('reveal');
  sceneImage.onload = () => sceneImage.classList.add('reveal');
  sceneImage.src = selected.dataset.src;
  sceneImage.alt = selected.dataset.caption;
  sceneCaption.textContent = selected.dataset.caption;
  for (const button of sceneControls.querySelectorAll('button')) {
    button.setAttribute('aria-pressed', String(button === selected));
  }
});

const demo = document.getElementById('lightfuseVideo');
document.querySelector('.actions a[href="#demo"]').addEventListener('click', () => {
  demo.play().catch(() => { /* Native video controls remain available. */ });
});

// Limit simultaneous decoding to the property clips currently in view.
if ('IntersectionObserver' in window && !matchMedia('(prefers-reduced-motion: reduce)').matches) {
  const observer = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      if (entry.isIntersecting) {
        entry.target.play().catch(() => { /* The user can start playback manually. */ });
      } else {
        entry.target.pause();
      }
    }
  }, {threshold: 0.4});
  document.querySelectorAll('.property-grid video').forEach((video) => observer.observe(video));
}

const editComparisons = {
  lighting: {
    left: ['moved', 'Bridge', 'Gray chair beside the desk under Bridge lighting'],
    right: ['sunrise', 'Sunrise', 'Same gray chair and layout under Sunrise lighting'],
    caption: 'Drag to compare the same chair under two environment maps. Watch the shadow cross the floor and wall.'
  },
  pose: {
    left: ['base', 'Original pose', 'Gray chair angled toward the desk'],
    right: ['moved', 'New pose', 'Gray chair moved away from the desk and rotated'],
    caption: 'Follow the chair and its shadow as it turns away from the desk under the same lighting.'
  }
};

const comparison = document.querySelector('.compare-stage');
const modes = document.querySelector('.compare-modes');
const slider = comparison.querySelector('input');
const comparisonNote = document.querySelector('.comparison-note');
function updateSplit() {
  comparison.style.setProperty('--split', slider.value + '%');
  slider.setAttribute('aria-valuetext', slider.value + '% ' + slider.dataset.leftLabel);
}
comparison.classList.add('enhanced');
slider.hidden = false;
comparison.querySelector('.compare-line').hidden = false;
modes.hidden = false;
slider.addEventListener('input', updateSplit);
updateSplit();

modes.addEventListener('click', (event) => {
  const selected = event.target.closest('button');
  if (!selected || selected.getAttribute('aria-pressed') === 'true') return;
  const pair = editComparisons[selected.dataset.edit];
  for (const side of ['left', 'right']) {
    const [file, label, alt] = pair[side];
    const figure = comparison.querySelector('.compare-' + side);
    const image = figure.querySelector('img');
    image.src = './static/images/insight/bedroom-' + file + '.webp';
    image.alt = alt;
    figure.querySelector('figcaption').textContent = label;
  }
  for (const button of modes.querySelectorAll('button')) {
    button.setAttribute('aria-pressed', String(button === selected));
  }
  slider.value = 50;
  slider.dataset.leftLabel = pair.left[1];
  updateSplit();
  comparisonNote.textContent = pair.caption;
});

const picker = document.querySelector('.object-picker');
const objectButtons = Array.from(picker.querySelectorAll('.object-option'));
const objectPanels = document.querySelectorAll('.object-panel');
document.querySelector('.object-display').addEventListener('modelsurfacechange', event => {
  const url = new URL(location.href);
  if (event.detail === 'normal' && url.searchParams.get('surface') !== 'normal') {
    url.searchParams.set('object', event.target.closest('.object-panel').id.slice('object-'.length));
    url.searchParams.set('surface', 'normal');
    url.hash = 'explore';
  } else if (event.detail !== 'normal' && url.searchParams.has('surface')) {
    url.searchParams.delete('surface');
  } else {
    return;
  }
  history.replaceState(null, '', url);
});
function selectObject(button, openViewer) {
  const activePanel = document.getElementById(button.getAttribute('aria-controls'));
  for (const panel of objectPanels) {
    if (panel !== activePanel && !panel.hidden) {
      panel.querySelector('.model-viewer').dispatchEvent(new Event('modelhide'));
    }
    panel.hidden = panel !== activePanel;
  }
  for (const option of objectButtons) {
    option.setAttribute('aria-pressed', String(option === button));
  }
  if (openViewer) {
    const launch = activePanel.querySelector('.model-launch');
    if (!launch.hidden && !launch.disabled) launch.click();
  }
}
const galleryUrl = new URL(location.href);
// Keep previously shared room links pointing to an object from the same scan.
if (galleryUrl.searchParams.has('room') || galleryUrl.hash === '#room') {
  const fromLivingroom = galleryUrl.searchParams.get('room') === 'livingroom';
  if (!galleryUrl.searchParams.has('object')) galleryUrl.searchParams.set('object', fromLivingroom ? 'armchair' : 'toy-car');
  galleryUrl.searchParams.delete('room');
  galleryUrl.hash = 'explore';
  history.replaceState(null, '', galleryUrl);
}
const hasObjectLink = galleryUrl.searchParams.has('object');
const initialObject = objectButtons.find(button =>
  button.getAttribute('aria-controls') === 'object-' + galleryUrl.searchParams.get('object')
) || objectButtons[0];
const initialPanelId = initialObject.getAttribute('aria-controls');
if (hasObjectLink && initialPanelId !== 'object-' + galleryUrl.searchParams.get('object')) {
  galleryUrl.searchParams.set('object', initialPanelId.slice('object-'.length));
  history.replaceState(null, '', galleryUrl);
}
if (hasObjectLink && galleryUrl.searchParams.get('surface') === 'normal') {
  const panel = document.getElementById(initialPanelId);
  panel.querySelector('.model-viewer').dataset.initialSurface = 'normal';
}
selectObject(initialObject, false);
if (hasObjectLink && (!galleryUrl.hash || galleryUrl.hash === '#explore')) {
  document.addEventListener('DOMContentLoaded', () => {
    document.getElementById('explore').scrollIntoView();
    selectObject(initialObject, true);
  }, {once: true});
}
picker.hidden = false;
picker.addEventListener('click', (event) => {
  const button = event.target.closest('.object-option');
  if (!button) return;
  selectObject(button, true);
  const panel = document.getElementById(button.getAttribute('aria-controls'));
  if (event.detail > 0 && matchMedia('(max-width: 50rem)').matches &&
      panel.getBoundingClientRect().top < document.querySelector('.masthead').getBoundingClientRect().bottom) {
    panel.scrollIntoView({block: 'start'});
  }
  const url = new URL(location.href);
  url.searchParams.set('object', button.getAttribute('aria-controls').slice('object-'.length));
  url.hash = 'explore';
  history.replaceState(null, '', url);
});
for (const link of document.querySelectorAll('a[href="#explore"]')) {
  link.addEventListener('click', () => selectObject(picker.querySelector('.object-option[aria-pressed="true"]'), true));
}

const relightSettings = document.querySelector('.relight-settings');
const relightFrame = document.getElementById('relight-frame');
const relightCaption = document.getElementById('relight-frame-caption');
const relightStatus = relightSettings.querySelector('.relight-status');
let latestRelightRequest = 0;
let displayedRoom = relightSettings.elements.room.value;
let displayedEnvironment = relightSettings.elements.environment.value;
relightSettings.hidden = false;

relightSettings.addEventListener('change', async () => {
  const room = relightSettings.querySelector('[name="room"]:checked');
  const environment = relightSettings.querySelector('[name="environment"]:checked');
  const request = ++latestRelightRequest;
  const image = new Image();
  image.src = `./static/images/relighting/${room.value}-${room.dataset.camera}-${environment.value}.webp`;
  relightStatus.textContent = 'Loading render…';
  try {
    await image.decode();
    if (request !== latestRelightRequest) return;
    relightFrame.src = image.src;
    relightFrame.alt = 'LightFuse rendering of the ' + room.dataset.label + ' under the ' + environment.dataset.label + ' environment';
    relightCaption.textContent = room.dataset.label + ' · ' + environment.dataset.label + ' · Camera ' + room.dataset.camera;
    displayedRoom = room.value;
    displayedEnvironment = environment.value;
    relightStatus.textContent = '';
  } catch {
    if (request !== latestRelightRequest) return;
    relightSettings.elements.room.value = displayedRoom;
    relightSettings.elements.environment.value = displayedEnvironment;
    relightStatus.textContent = 'This render could not load. Select an environment to try again.';
  }
});
