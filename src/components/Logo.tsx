/**
 * GifSmith wordmark in Space Grotesk: two-tone weight (bold "Gif" with the
 * signature gradient, lighter "Smith" in secondary text), framed by the
 * iOS-style timeline trim selection (gold grab-handles + rails).
 */
export default function Logo() {
  return (
    <div class="logo" role="img" aria-label="GifSmith">
      <span class="logo-frame">
        <span class="logo-handle logo-handle-l" />
        <span class="logo-word">
          <span class="logo-gif">Gif</span>
          <span class="logo-smith">Smith</span>
        </span>
        <span class="logo-handle logo-handle-r" />
      </span>
    </div>
  );
}
