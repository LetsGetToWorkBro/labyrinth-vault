//  LabyrinthVaultNative.m
//  React Native bridge declarations for the two native modules. The Swift
//  carries the behaviour; this file only makes it callable from Hermes.

#import <React/RCTBridgeModule.h>

@interface RCT_EXTERN_MODULE(VaultKeychain, NSObject)

RCT_EXTERN_METHOD(set:(NSString *)key
                  value:(NSString *)value
                  accessibility:(NSString *)accessibility
                  resolver:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject)

RCT_EXTERN_METHOD(get:(NSString *)key
                  resolver:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject)

RCT_EXTERN_METHOD(remove:(NSString *)key
                  resolver:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject)

@end
