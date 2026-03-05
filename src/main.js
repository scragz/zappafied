// src/main.js

import Alpine from 'alpinejs';
import { zappafiedApp } from './app.js';
import './styles.scss'; // Import SCSS for processing

// Initialize Alpine
window.Alpine = Alpine;
Alpine.data('zappafiedApp', zappafiedApp);
Alpine.start();
