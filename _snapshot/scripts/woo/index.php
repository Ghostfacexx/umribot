<?php
// Required fallback template for classic themes.
// WordPress will use front-page.php for the homepage automatically if it exists.
// index.php just provides a final fallback so the theme is valid.
if (!defined('ABSPATH')) { exit; }
get_header();
if (have_posts()) :
  while (have_posts()) : the_post();
    the_content();
  endwhile;
endif;
get_footer();