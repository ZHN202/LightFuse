document.addEventListener('DOMContentLoaded', function () {
  var heroVideo = document.getElementById('lightfuseVideo');
  if (heroVideo) {
    heroVideo.play().catch(function () {
      // Browsers may block autoplay; the native controls remain available.
    });
  }

  var resultVideos = Array.prototype.slice.call(document.querySelectorAll('.result-video'));
  if (!resultVideos.length || !('IntersectionObserver' in window)) return;

  var observer = new IntersectionObserver(function (entries) {
    entries.forEach(function (entry) {
      var video = entry.target;
      if (entry.isIntersecting) {
        video.play().catch(function () {
          // Browsers may block autoplay; the native controls remain available.
        });
      } else {
        video.pause();
      }
    });
  }, {
    threshold: 0.35
  });

  resultVideos.forEach(function (video) {
    observer.observe(video);
  });
});
