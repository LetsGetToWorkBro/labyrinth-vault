/** Entry point. boot.js first — see the note there; the order is the point. */
import './boot';
import { AppRegistry } from 'react-native';
import { App } from './App';

AppRegistry.registerComponent('LabyrinthVault', () => App);
