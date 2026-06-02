/**
 * GifSmith wordmark: the name framed by the iOS-style timeline trim selection
 * (yellow grab-handles on each side, selection rails top and bottom), reusing
 * the editor's visual language. Pure CSS so it themes with the rest of the app.
 */
export default function Logo() {
  return (
    <div class="logo" role="img" aria-label="GifSmith">
      <span class="logo-frame">
        <span class="logo-handle logo-handle-l" />
        <span class="logo-word">
          Gif<span class="logo-word-accent">Smith</span>
        </span>
        <span class="logo-handle logo-handle-r" />
      </span>
    </div>
  );
}
