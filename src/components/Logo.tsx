/**
 * GifSmith wordmark in Space Grotesk: two-tone weight (bold "Gif" with the
 * signature gradient, lighter "Smith" in secondary text), tight tracking, no
 * box or effects. The trim-handle motif lives on the real scrubber, not here.
 */
export default function Logo() {
  return (
    <div class="logo" role="img" aria-label="GifSmith">
      <span class="logo-word">
        <span class="logo-gif">Gif</span>
        <span class="logo-smith">Smith</span>
      </span>
    </div>
  );
}
