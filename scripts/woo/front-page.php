<?php
if (!defined('ABSPATH')) { exit; }
get_header();
while (have_posts()) : the_post();
  the_content(); // Renders your imported homepage HTML as-is
endwhile;
get_footer();