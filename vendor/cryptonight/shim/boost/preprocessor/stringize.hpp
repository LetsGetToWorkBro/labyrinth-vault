/*
 * NOT upstream, and not Boost either. Ours.
 *
 * Monero's `contrib/epee/include/warnings.h` opens with
 *
 *     #include <boost/preprocessor/stringize.hpp>
 *
 * and `src/crypto/hash-ops.h` includes `warnings.h`, so every file in this
 * target reaches for Boost. What it actually uses Boost for, in the whole of
 * the vendored set, is this:
 *
 *     hash-ops.h:57   PUSH_WARNINGS
 *     hash-ops.h:58   DISABLE_VS_WARNINGS(4267)
 *     hash-ops.h:67   POP_WARNINGS
 *
 * a `#pragma GCC diagnostic push/pop` around a `static_assert`, plus a macro
 * that expands to nothing on any compiler that is not MSVC. `BOOST_PP_STRINGIZE`
 * itself is used only by `DISABLE_GCC_AND_CLANG_WARNING`, which nothing here
 * calls. So the choice was a Boost dependency for a pragma, or fourteen lines.
 *
 * The definition below is the real two-step stringize and not a placeholder:
 * the indirection through `_I` is what makes `BOOST_PP_STRINGIZE(FOO)` expand
 * `FOO` before quoting it, which is the entire difference between this and a
 * bare `#x`. If some future upstream file does start using it, it behaves.
 */

#ifndef LABYRINTH_SHIM_BOOST_PP_STRINGIZE_HPP
#define LABYRINTH_SHIM_BOOST_PP_STRINGIZE_HPP

#define BOOST_PP_STRINGIZE_I(text) #text
#define BOOST_PP_STRINGIZE(text) BOOST_PP_STRINGIZE_I(text)

#endif
